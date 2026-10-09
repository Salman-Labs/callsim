import { WebSocket, type RawData } from 'ws';
import { FRAME_MS, SAMPLE_RATE, UNDERRUN_FLOOR_MS, UTTERANCE_SETTLE_MS } from '../constants.js';
import { pcmToFrames } from '../audio.js';
import { mulawToPcm16 } from '../mulaw.js';
import { Playback } from '../playback.js';
import {
  connectedMessage,
  createSid,
  inspectMediaPayload,
  normalizeWsUrl,
  parseBotMessage,
  startMessage,
} from '../protocol.js';
import { ScenarioConnectionError, ScenarioUsageError } from '../scenario/errors.js';
import type { FormatProblem } from '../types.js';
import type {
  AgentAudioFrame,
  AgentPresence,
  AgentVadEvent,
  CallerAudio,
  CallerPlayout,
  TranscriptEvent,
  Transport,
  TransportConnectOptions,
  TransportSnapshot,
} from '../transport.js';
import { resampleLinear } from '../wav.js';
import { StereoRecording } from '../recording.js';

/**
 * Twilio Media Streams caller. Frames, μ-law, marks, and `clear` follow the
 * same playback clock as `simulateCall`.
 */
export function createTwilioTransport(): Transport {
  return new TwilioTransport();
}

class TwilioTransport implements Transport {
  readonly name = 'twilio';
  private ws: WebSocket | null = null;
  private playback: Playback | null = null;
  private readonly recording = new StereoRecording();
  private origin = 0;
  private streamStartedAt = 0;
  private sequence = 0;
  private chunk = 1;
  private streamSid = '';
  private callSid = '';
  private accountSid = '';
  private url = '';
  private marksReceived = 0;
  private marksEchoed = 0;
  private marksPlayed = 0;
  private marksCleared = 0;
  private formatProblemCount = 0;
  private readonly formatProblems: FormatProblem[] = [];
  private readonly clears: { atMs: number; msFromBarge: number | null; agentAudioAfterMs: number }[] = [];
  private bargePerf: number | null = null;
  private clearPerf: number | null = null;
  private audioAfterClearMs = 0;
  private inCallerAudio = false;
  private hungUp = false;
  private stopping = false;
  private speechStartMs: number | null = null;
  private lastAudioEndMs = 0;
  private readonly warningsList: string[] = [];
  private readonly audioListeners = new Set<(frame: AgentAudioFrame) => void>();
  private readonly vadListeners = new Set<(event: AgentVadEvent) => void>();
  private readonly saidListeners = new Set<(event: TranscriptEvent) => void>();
  private readonly heardListeners = new Set<(event: TranscriptEvent) => void>();

  async connect(options: TransportConnectOptions): Promise<void> {
    if (this.ws) throw new ScenarioUsageError('Twilio transport is already connected');
    const url = stringField(options.config.url) || process.env.TWILIO_URL || '';
    if (!url) throw new ScenarioUsageError('Set twilio.url or TWILIO_URL to the bot Media Stream WebSocket.');
    this.url = normalizeWsUrl(url);
    this.streamSid = createSid('MZ');
    this.callSid = createSid('CA');
    this.accountSid = createSid('AC');
    const params = stringParams(options.config.params);
    await this.openSocket();
    this.origin = performance.now();
    this.send(connectedMessage());
    this.send(
      startMessage({
        sequenceNumber: this.nextSeq(),
        streamSid: this.streamSid,
        callSid: this.callSid,
        accountSid: this.accountSid,
        customParameters: params,
      }),
    );
    this.streamStartedAt = performance.now();
    this.origin = this.streamStartedAt;
    this.playback = new Playback({
      underrunFloorMs: UNDERRUN_FLOOR_MS,
      utteranceSettleMs: UTTERANCE_SETTLE_MS,
      streamStartedAt: () => this.streamStartedAt,
      recording: this.recording,
      onMark: (name, reason) => this.echoMark(name, reason),
      onUtteranceStart: (now) => {
        this.speechStartMs = now - this.origin;
        this.emitVad({ type: 'start', atMs: this.speechStartMs });
      },
      onUtteranceEnd: () => {
        const atMs = this.lastAudioEndMs || this.now();
        const speechMs = this.speechStartMs === null ? undefined : Math.max(0, Math.round(atMs - this.speechStartMs));
        this.speechStartMs = null;
        this.emitVad({ type: 'stop', atMs, ...(speechMs !== undefined ? { speechMs } : {}) });
      },
      onPlayed: (pcm, atMs) => {
        this.lastAudioEndMs = atMs + (pcm.length / SAMPLE_RATE) * 1000;
        const frame = { pcm, sampleRate: SAMPLE_RATE, atMs };
        for (const listener of this.audioListeners) listener(frame);
      },
    });
    options.onEvent?.({ t: 0, type: 'twilio_start', streamSid: this.streamSid, callSid: this.callSid });
  }

  async waitForAgent(timeoutMs: number): Promise<AgentPresence> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ScenarioConnectionError(`agent_not_joined: Twilio bot did not accept the stream within ${timeoutMs} ms`, 'agent_not_joined');
    }
    return { identity: 'twilio-media-stream', joinedMs: this.now() };
  }

  async playCallerAudio(audio: CallerAudio): Promise<CallerPlayout> {
    const pcm = resampleLinear(audio.pcm, audio.sampleRate, SAMPLE_RATE);
    const frames = pcmToFrames(pcm);
    const audioMs = SAMPLE_RATE > 0 ? (pcm.length / SAMPLE_RATE) * 1000 : 0;
    const startedAtMs = this.now();
    const start = performance.now();
    this.bargePerf = this.playback?.utteranceOpen ? start : null;
    this.clearPerf = null;
    this.audioAfterClearMs = 0;
    this.inCallerAudio = true;
    try {
      for (let i = 0; i < frames.length; i += 1) {
        await sleepUntil(start + i * FRAME_MS);
        const frame = frames[i]!;
        const at = performance.now();
        this.send({
          event: 'media',
          sequenceNumber: this.nextSeq(),
          streamSid: this.streamSid,
          media: {
            track: 'inbound',
            chunk: String(this.chunk),
            timestamp: String(Math.max(0, Math.round(at - this.streamStartedAt))),
            payload: frame.toString('base64'),
          },
        });
        this.chunk += 1;
      }
      if (frames.length > 0) await sleepUntil(start + frames.length * FRAME_MS);
    } finally {
      this.inCallerAudio = false;
      const last = this.clears[this.clears.length - 1];
      if (last && this.bargePerf !== null) last.agentAudioAfterMs = Math.round(this.audioAfterClearMs);
    }
    const barge =
      this.bargePerf === null
        ? undefined
        : {
            clearReceived: this.clearPerf !== null,
            msToClear: this.clearPerf === null ? null : Math.max(0, Math.round(this.clearPerf - this.bargePerf)),
            agentAudioAfterMs: Math.round(this.audioAfterClearMs),
          };
    return { audioMs, startedAtMs, endedAtMs: this.now(), ...(barge ? { barge } : {}) };
  }

  async sendDtmf(digits: string): Promise<void> {
    for (const digit of digits) {
      this.send({
        event: 'dtmf',
        streamSid: this.streamSid,
        sequenceNumber: this.nextSeq(),
        dtmf: { track: 'inbound_track', digit },
      });
      await delay(160);
    }
  }

  onAgentAudio(listener: (frame: AgentAudioFrame) => void): () => void {
    this.audioListeners.add(listener);
    return () => {
      this.audioListeners.delete(listener);
    };
  }

  onAgentVad(listener: (event: AgentVadEvent) => void): () => void {
    this.vadListeners.add(listener);
    return () => {
      this.vadListeners.delete(listener);
    };
  }

  onAgentTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.saidListeners.add(listener);
    return () => {
      this.saidListeners.delete(listener);
    };
  }

  onCallerHeard(listener: (event: TranscriptEvent) => void): () => void {
    this.heardListeners.add(listener);
    return () => {
      this.heardListeners.delete(listener);
    };
  }

  agentState(): string | null {
    return this.playback?.utteranceOpen ? 'speaking' : 'listening';
  }

  now(): number {
    if (!this.origin) return 0;
    return Math.max(0, Math.round(performance.now() - this.origin));
  }

  roomId(): string | undefined {
    return this.streamSid || undefined;
  }

  warnings(): readonly string[] {
    return this.warningsList;
  }

  hasNativeTranscript(): boolean {
    return false;
  }

  snapshot(): TransportSnapshot {
    const gapsMs = (this.playback?.gapsMs ?? []).map((gap) => Math.round(gap));
    return {
      twilio: {
        streamSid: this.streamSid,
        callSid: this.callSid,
        underruns: {
          count: gapsMs.length,
          longestGapMs: gapsMs.reduce((max, gap) => Math.max(max, gap), 0),
          gapsMs,
        },
        marks: {
          received: this.marksReceived,
          echoed: this.marksEchoed,
          played: this.marksPlayed,
          cleared: this.marksCleared,
        },
        formatProblemCount: this.formatProblemCount,
        clears: this.clears.map((item) => ({ ...item })),
      },
    };
  }

  async hangup(): Promise<void> {
    if (this.hungUp) return;
    this.hungUp = true;
    this.stopping = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        event: 'stop',
        sequenceNumber: this.nextSeq(),
        streamSid: this.streamSid,
        stop: { accountSid: this.accountSid, callSid: this.callSid },
      });
      this.ws.close();
    }
    this.playback?.dispose();
    this.ws = null;
  }

  private async openSocket(): Promise<void> {
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ScenarioConnectionError(`timed out connecting to ${safeUrl(this.url)}`, 'connect_failed'));
      }, 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(new ScenarioConnectionError(`failed to connect to ${safeUrl(this.url)}: ${err.message}`, 'connect_failed'));
      });
    });
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => {
      if (!this.stopping) this.warningsList.push('Twilio bot closed the Media Stream');
    });
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.addProblem({ kind: 'non-mulaw', detail: 'bot sent a binary WebSocket frame; Media Streams uses JSON text frames' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawToString(data));
    } catch {
      this.addProblem({ kind: 'invalid-json', detail: 'bot frame was not JSON' });
      return;
    }
    const msg = parseBotMessage(parsed);
    if (msg.kind === 'invalid') {
      this.addProblem({ kind: 'invalid-message', detail: msg.detail });
      return;
    }
    if (msg.kind === 'ignored') return;
    this.noteStreamSid(msg.streamSid);
    const now = performance.now();
    if (msg.kind === 'clear') {
      this.onClear(now);
      return;
    }
    if (msg.kind === 'mark') {
      this.marksReceived += 1;
      this.playback?.enqueueMark(msg.name, now);
      return;
    }
    if (msg.encoding && !/mulaw/i.test(msg.encoding)) {
      this.addProblem({ kind: 'non-mulaw', detail: `bot declared encoding ${msg.encoding}` });
    }
    const inspected = inspectMediaPayload(msg.payload);
    for (const problem of inspected.problems) this.addProblem(problem);
    if (!inspected.bytes) return;
    const durationMs = (inspected.bytes.length / SAMPLE_RATE) * 1000;
    if (this.inCallerAudio && this.clearPerf !== null) this.audioAfterClearMs += durationMs;
    this.playback?.enqueueAudio(mulawToPcm16(inspected.bytes), now);
  }

  private onClear(now: number): void {
    const atMs = Math.max(0, Math.round(now - this.origin));
    const msFromBarge = this.bargePerf === null ? null : Math.max(0, Math.round(now - this.bargePerf));
    if (this.clearPerf === null) this.clearPerf = now;
    this.lastAudioEndMs = atMs;
    this.playback?.clear(now);
    this.clears.push({ atMs, msFromBarge, agentAudioAfterMs: 0 });
  }

  private echoMark(name: string, reason: 'playback' | 'clear'): void {
    this.marksEchoed += 1;
    if (reason === 'clear') this.marksCleared += 1;
    else this.marksPlayed += 1;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.stopping) return;
    this.send({
      event: 'mark',
      sequenceNumber: this.nextSeq(),
      streamSid: this.streamSid,
      mark: { name },
    });
  }

  private noteStreamSid(streamSid: string | undefined): void {
    if (streamSid === undefined) {
      this.addProblem({ kind: 'missing-stream-sid', detail: 'bot message omitted streamSid' });
      return;
    }
    if (streamSid !== this.streamSid) {
      this.addProblem({ kind: 'stream-sid-mismatch', detail: 'bot streamSid does not match the start message' });
    }
  }

  private addProblem(problem: FormatProblem): void {
    this.formatProblemCount += 1;
    if (this.formatProblems.length < 8) this.formatProblems.push(problem);
  }

  private emitVad(event: AgentVadEvent): void {
    for (const listener of this.vadListeners) listener(event);
  }

  private send(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private nextSeq(): string {
    this.sequence += 1;
    return String(this.sequence);
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringParams(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
  }
  return out;
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '(invalid url)';
  }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(new Uint8Array(data)).toString('utf8');
}

function sleepUntil(at: number): Promise<void> {
  const delayMs = at - performance.now();
  if (delayMs <= 0) return Promise.resolve();
  return delay(delayMs);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
