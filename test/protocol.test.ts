import { describe, expect, it } from 'vitest';
import { tonePcm } from '../src/audio.js';
import { simulateCall } from '../src/simulate.js';
import { listen } from '../examples/server.js';

describe('Media Streams wire protocol', () => {
  it('sends connected, start, paced media, dtmf, and stop', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const bot = await listen(0, (ws) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    try {
      await simulateCall({
        url: bot.url,
        turns: [{ pcm16: tonePcm(60), label: 'tone' }],
        dtmf: '1#',
        params: { FirstName: 'Ada' },
        silence: 0,
        responseGraceMs: 80,
        timeout: 5,
      });
    } finally {
      await bot.close();
    }

    expect(messages[0]).toEqual({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    expect(messages[0]).not.toHaveProperty('sequenceNumber');
    const start = messages[1] as {
      event: string;
      sequenceNumber: string;
      streamSid: string;
      start: {
        streamSid: string;
        callSid: string;
        accountSid: string;
        tracks: string[];
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
        customParameters: Record<string, string>;
      };
    };
    expect(start.event).toBe('start');
    expect(start.sequenceNumber).toBe('1');
    expect(start.streamSid.startsWith('MZ')).toBe(true);
    expect(start.start.streamSid).toBe(start.streamSid);
    expect(start.start.callSid.startsWith('CA')).toBe(true);
    expect(start.start.accountSid.startsWith('AC')).toBe(true);
    expect(start.start.tracks).toEqual(['inbound']);
    expect(start.start.mediaFormat).toEqual({ encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 });
    expect(start.start.customParameters).toEqual({ FirstName: 'Ada' });

    const media = messages.filter((msg) => msg.event === 'media');
    expect(media).toHaveLength(3);
    const times = media.map((msg) => Number((msg.media as { timestamp: string }).timestamp));
    expect(times[1]! - times[0]!).toBeGreaterThan(10);
    expect(times[1]! - times[0]!).toBeLessThan(40);
    expect(times[2]! - times[1]!).toBeGreaterThan(10);
    media.forEach((msg, index) => {
      const body = msg.media as { track: string; chunk: string; payload: string };
      expect(msg.sequenceNumber).toBe(String(index + 2));
      expect(body.track).toBe('inbound');
      expect(body.chunk).toBe(String(index + 1));
      expect(Buffer.from(body.payload, 'base64')).toHaveLength(160);
    });

    const dtmf = messages.filter((msg) => msg.event === 'dtmf');
    expect(dtmf.map((msg) => (msg.dtmf as { digit: string; track: string }).digit)).toEqual(['1', '#']);
    expect((dtmf[0]!.dtmf as { track: string }).track).toBe('inbound_track');

    const stop = messages.at(-1) as {
      event: string;
      sequenceNumber: string;
      stop: { callSid: string; accountSid: string };
    };
    expect(stop.event).toBe('stop');
    expect(stop.sequenceNumber).toBe(String(messages.length - 1));
    expect(stop.stop.callSid).toBe(start.start.callSid);
    expect(stop.stop.accountSid).toBe(start.start.accountSid);
  });

  it('flags a short frame and a container header', async () => {
    const bot = await listen(0, (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { event?: string; streamSid?: string };
        if (msg.event !== 'start' || !msg.streamSid) return;
        ws.send(
          JSON.stringify({
            event: 'media',
            streamSid: msg.streamSid,
            media: { payload: Buffer.alloc(50, 0xff).toString('base64') },
          }),
        );
        ws.send(
          JSON.stringify({
            event: 'media',
            streamSid: msg.streamSid,
            media: { payload: Buffer.from('RIFF....junk').toString('base64') },
          }),
        );
      });
    });
    try {
      const report = await simulateCall({
        url: bot.url,
        turns: [{ pcm16: tonePcm(40), label: 'tone' }],
        responseGraceMs: 200,
        timeout: 4,
      });
      expect(report.formatProblems.map((problem) => problem.kind)).toEqual(
        expect.arrayContaining(['unexpected-frame-size', 'non-mulaw']),
      );
    } finally {
      await bot.close();
    }
  });
});
