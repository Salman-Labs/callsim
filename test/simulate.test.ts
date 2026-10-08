import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { tonePcm } from '../src/audio.js';
import { pcm16ToMulaw } from '../src/mulaw.js';
import { reportJson } from '../src/thresholds.js';
import { simulateCall, type CallReport } from '../src/index.js';
import { decodeWav, encodeWav } from '../src/wav.js';
import { startBuggyBot } from '../examples/buggy-bot.js';
import { startGoodBot } from '../examples/good-bot.js';
import { listen } from '../examples/server.js';
import { mediaMessage, markMessage, splitFrames } from '../examples/frames.js';

const THRESHOLDS = { maxFirstAudioMs: 450, maxGapMs: 40, requireBargeIn: true };

describe('simulateCall', () => {
  it('passes the good echo bot', async () => {
    const bot = await startGoodBot();
    try {
      const report = await simulateCall({
        url: bot.url,
        turns: [
          { pcm16: tonePcm(200, 440), label: 'hello' },
          { pcm16: tonePcm(200, 660), label: 'hello' },
        ],
        bargeIn: 0.12,
        thresholds: THRESHOLDS,
        timeout: 8,
      });
      expect(brief(report)).toMatch(/PASS|true/);
      expect(report.ok, brief(report)).toBe(true);
      expect(report.turns[0]?.firstAudioMs).toBeLessThan(350);
      expect(report.turns[1]?.firstAudioMs).toBeLessThan(350);
      expect(report.underruns.count).toBe(0);
      expect(report.formatProblemCount).toBe(0);
      expect(report.bargeIn[0]?.clearReceived).toBe(true);
      expect(report.bargeIn[0]?.msToClear ?? 999).toBeLessThan(200);
      expect(report.bargeIn[0]?.botAudioAfterClearMs).toBeLessThanOrEqual(40);
      expect(report.marksEchoed).toBeGreaterThanOrEqual(1);
      const wav = decodeWav(report.recordingWav);
      expect(wav.channels).toBe(2);
      expect(wav.sampleRate).toBe(8000);
      expect(span(wav.pcm16, wav.channels, 0).active).toBeGreaterThan(100);
      expect(span(wav.pcm16, wav.channels, 1).active).toBeGreaterThan(40);
    } finally {
      await bot.close();
    }
  });

  it('fails the buggy bot on underruns and a missing clear', async () => {
    const bot = await startBuggyBot();
    try {
      const report = await simulateCall({
        url: bot.url,
        turns: [
          { pcm16: tonePcm(200, 440), label: 'hello' },
          { pcm16: tonePcm(200, 660), label: 'hello' },
        ],
        bargeIn: 0.12,
        thresholds: THRESHOLDS,
        timeout: 12,
      });
      expect(report.ok, brief(report)).toBe(false);
      expect(report.underruns.count).toBeGreaterThan(0);
      expect(report.underruns.longestGapMs).toBeGreaterThan(50);
      expect(report.bargeIn[0]?.clearReceived).toBe(false);
      expect(report.turns[0]?.firstAudioMs ?? 0).toBeGreaterThan(450);
      expect(report.failures.some((failure) => /underrun|gap/i.test(failure))).toBe(true);
      expect(report.failures.some((failure) => /clear/i.test(failure))).toBe(true);
    } finally {
      await bot.close();
    }
  });

  it('echoes a mark only after the queued audio has played', async () => {
    const marks: number[] = [];
    let sentAt = 0;
    const bot = await listen(0, (ws) => replyOnce(ws, 400, marks, (at) => (sentAt = at)));
    try {
      await simulateCall({
        url: bot.url,
        turns: [{ pcm16: tonePcm(80), label: 'go' }],
        responseGraceMs: 500,
        timeout: 5,
      });
    } finally {
      await bot.close();
    }
    expect(marks.length).toBe(1);
    const delay = marks[0]! - sentAt;
    expect(delay).toBeGreaterThan(300);
    expect(delay).toBeLessThan(700);
  });

  it('drops unplayed audio on clear and echoes the mark immediately', async () => {
    const marks: number[] = [];
    let sentAt = 0;
    const bot = await listen(0, (ws) => {
      let streamSid = '';
      let started = false;
      let cleared = false;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as {
          event?: string;
          streamSid?: string;
          mark?: { name?: string };
        };
        if (msg.event === 'start' && msg.streamSid) streamSid = msg.streamSid;
        if (msg.event === 'mark') marks.push(performance.now());
        if (msg.event !== 'media' || !streamSid) return;
        if (!started) {
          started = true;
          sendAudio(ws, streamSid, 1000);
          sentAt = performance.now();
          ws.send(markMessage(streamSid, 'reply'));
          return;
        }
        // Ignore the rest of the first caller turn. The interrupting turn
        // arrives well after this, once playback is underway.
        if (!cleared && performance.now() - sentAt > 150) {
          cleared = true;
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }
      });
    });
    try {
      const report = await simulateCall({
        url: bot.url,
        turns: [
          { pcm16: tonePcm(80), label: 'a' },
          { pcm16: tonePcm(80), label: 'b' },
        ],
        bargeIn: 0.2,
        responseGraceMs: 300,
        timeout: 5,
      });
      expect(report.bargeIn[0]?.clearReceived).toBe(true);
      expect(marks.length).toBeGreaterThanOrEqual(1);
      const delay = marks[0]! - sentAt;
      expect(delay).toBeGreaterThan(100);
      expect(delay).toBeLessThan(500);
      const wav = decodeWav(report.recordingWav);
      const played = span(wav.pcm16, wav.channels, 1);
      expect(played.active).toBeGreaterThan(80);
      expect(played.active).toBeLessThan(500);
    } finally {
      await bot.close();
    }
  });

  it('reads a caller WAV and can add jitter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'callsim-'));
    const wavPath = join(dir, 'caller.wav');
    const out = join(dir, 'call.wav');
    writeFileSync(wavPath, encodeWav(tonePcm(40, 880, 16000), 16000, 1));
    const bot = await listen(0, () => undefined);
    try {
      const report = await simulateCall({
        url: bot.url,
        turns: [{ wavPath }],
        jitter: 5,
        out,
        responseGraceMs: 60,
        timeout: 4,
      });
      expect(report.recording.path).toBe(out);
      const written = readFileSync(out);
      expect(written.subarray(0, 4).toString()).toBe('RIFF');
      expect(report.turns[0]?.label).toBe('caller.wav');
    } finally {
      await bot.close();
    }
  });
});

function brief(report: CallReport): string {
  return JSON.stringify(reportJson(report), null, 2);
}

function span(pcm: Int16Array, channels: number, channel: number): { active: number } {
  const frames = Math.floor(pcm.length / channels);
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames; i += 1) {
    const sample = pcm[i * channels + channel] ?? 0;
    if (Math.abs(sample) > 200) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || last < 0) return { active: 0 };
  return { active: ((last - first) / 8000) * 1000 };
}

function replyOnce(ws: WebSocket, ms: number, marks: number[], stamp: (at: number) => void): void {
  let streamSid = '';
  let started = false;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as { event?: string; streamSid?: string };
    if (msg.event === 'start' && msg.streamSid) streamSid = msg.streamSid;
    if (msg.event === 'mark') marks.push(performance.now());
    if (msg.event === 'media' && streamSid && !started) {
      started = true;
      sendAudio(ws, streamSid, ms);
      stamp(performance.now());
      ws.send(markMessage(streamSid, 'end'));
    }
  });
}

function sendAudio(ws: WebSocket, streamSid: string, ms: number): void {
  const frames = splitFrames(pcm16ToMulaw(tonePcm(ms)));
  for (const frame of frames) ws.send(mediaMessage(streamSid, frame));
}
