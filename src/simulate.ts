import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { audioForText, pcmToFrames } from './audio.js';
import {
  DEFAULT_RESPONSE_GRACE_MS,
  DEFAULT_SILENCE_SEC,
  DEFAULT_TIMEOUT_SEC,
  SAMPLE_RATE,
  UTTERANCE_SETTLE_MS,
  UNDERRUN_FLOOR_MS,
  FRAME_MS,
} from './constants.js';
import { debug } from './debug.js';
import { mulawToPcm16 } from './mulaw.js';
import { Playback } from './playback.js';
import {
  connectedMessage,
  createSid,
  inspectMediaPayload,
  normalizeWsUrl,
  parseBotMessage,
  startMessage,
} from './protocol.js';
import { StereoRecording } from './recording.js';
import { evaluateThresholds } from './thresholds.js';
import type {
  CallReport,
  FormatProblem,
  SimulateCallOptions,
  Thresholds,
  TurnInput,
} from './types.js';
import { decodeWav, resampleLinear, wavToMonoPcm8k } from './wav.js';

export class SimulateCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulateCallError';
  }
}

interface LiveTurn {
  index: number;
  label: string;
  frames: Buffer[];
  barge: boolean;
  endedAt: number | null;
  firstAudioMs: number | null;
  waiting: boolean;
  interruptAt: number | null;
  clearAt: number | null;
  botAudioAfterClearMs: number;
}

interface SpeechLatch {
  after: number;
  startedAt: number | null;
  waiter: ((at: number) => void) | null;
}

type AbortReason = 'timeout' | 'peer' | 'aborted' | 'error';

export async function simulateCall(options: SimulateCallOptions): Promise<CallReport> {
  validate(options);
  const session = new Session(options);
  return session.run();
}

function validate(options: SimulateCallOptions): void {
  if (!options.url) throw new SimulateCallError('url is required');
  if (!options.turns || options.turns.length === 0) {
    throw new SimulateCallError('at least one caller turn is required');
  }
  finite(options.bargeIn, 'bargeIn', 0);
  finite(options.silence, 'silence', 0);
  finite(options.jitter, 'jitter', 0);
  finite(options.underrunFloorMs, 'underrunFloorMs', 0);
  finite(options.responseGraceMs, 'responseGraceMs', 0);
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new SimulateCallError('timeout must be a positive number of seconds');
  }
  if (options.dtmf !== undefined && !/^[0-9*#]+$/.test(options.dtmf)) {
    throw new SimulateCallError('dtmf must contain only 0-9, *, and #');
  }
}

function finite(value: number | undefined, name: string, min: number): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < min) {
    throw new SimulateCallError(`${name} must be a number >= ${min}`);
  }
}

class Session {
  private readonly url: string;
  private readonly turns: LiveTurn[];
  private readonly silenceMs: number;
  private readonly bargeInMs: number | null;
  private readonly jitterMs: number;
  private readonly responseGraceMs: number;
  private readonly underrunFloorMs: number;
  private readonly timeoutSec: number;
  private readonly dtmf: string | undefined;
  private readonly outPath: string | undefined;
  private readonly thresholds: Thresholds | null;
  private readonly params: Record<string, string>;
  private readonly streamSid: string;
  private readonly callSid: string;
  private readonly accountSid: string;
  private readonly recording = new StereoRecording();
  private readonly abort = new AbortController();
  private readonly extraFailures: string[] = [];
  private readonly formatProblems: FormatProblem[] = [];

  private ws: WebSocket | null = null;
  private playback: Playback | null = null;
  private latch: SpeechLatch | null = null;
  private idleWaiter: (() => void) | null = null;
  private utteranceStartedAt: number | null = null;
  private sequence = 0;
  private chunk = 1;
  private formatProblemCount = 0;
  private marksReceived = 0;
  private marksEchoed = 0;
  private marksPlayed = 0;
  private marksCleared = 0;
  private unknownEvents = 0;
  private streamStartedAt = 0;
  private turnStartedAt = 0;
  private started = false;
  private stopping = false;
  private timedOut = false;
  private peerClosed = false;
  private abortedByCaller = false;
  private abortReason: AbortReason | null = null;
  private socketError: Error | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;

  constructor(options: SimulateCallOptions) {
    this.url = normalizeUrl(options.url);
    this.turns = options.turns.map((turn, index) => this.resolveTurn(turn, index));
    this.silenceMs = (options.silence ?? DEFAULT_SILENCE_SEC) * 1000;
    this.bargeInMs = options.bargeIn === undefined ? null : options.bargeIn * 1000;
    this.jitterMs = options.jitter ?? 0;
    this.responseGraceMs = options.responseGraceMs ?? DEFAULT_RESPONSE_GRACE_MS;
    this.underrunFloorMs = options.underrunFloorMs ?? UNDERRUN_FLOOR_MS;
    this.timeoutSec = options.timeout ?? DEFAULT_TIMEOUT_SEC;
    this.dtmf = options.dtmf;
    this.outPath = options.out;
    this.thresholds = options.thresholds ?? null;
    this.params = {};
    for (const [key, value] of Object.entries(options.params ?? {})) this.params[key] = String(value);
    this.streamSid = options.streamSid ?? createSid('MZ');
    this.callSid = options.callSid ?? createSid('CA');
    this.accountSid = options.accountSid ?? createSid('AC');
    this.streamStartedAt = performance.now();

    const timeoutMs = this.timeoutSec * 1000;
    this.timeoutTimer = setTimeout(() => {
      this.timedOut = true;
      this.triggerAbort('timeout');
    }, timeoutMs);
    options.signal?.addEventListener(
      'abort',
      () => {
        this.abortedByCaller = true;
        this.triggerAbort('aborted');
      },
      { once: true },
    );
  }

  async run(): Promise<CallReport> {
    try {
      await this.drive();
    } catch (err) {
      if (this.abortReason === 'error') {
        throw new SimulateCallError(`websocket error: ${this.socketError?.message ?? 'unknown error'}`);
      }
      if (!this.recoverable()) throw err;
    } finally {
      await this.shutdown();
    }
    return this.buildReport();
  }

  private async drive(): Promise<void> {
    await this.connect();
    this.sendStart();
    for (let i = 0; i < this.turns.length; i += 1) {
      this.throwIfAborted();
      const turn = this.turns[i]!;
      if (i > 0 && this.bargeInMs !== null) {
        const speechAt = await this.waitForSpeech(this.deadline());
        if (speechAt === null) {
          this.extraFailures.push(`turn ${turn.index} barge-in never heard the bot start speaking`);
          break;
        }
        const fireAt = speechAt + this.bargeInMs;
        if (fireAt > performance.now()) await this.sleepUntil(fireAt);
        turn.barge = true;
        turn.interruptAt = performance.now();
        debug(`barge-in turn ${turn.index}`);
      } else if (i > 0 && this.silenceMs > 0) {
        await this.sleep(this.silenceMs);
      }
      this.turnStartedAt = performance.now();
      await this.sendCaller(turn);
      this.armResponseLatch(turn);
      const last = i === this.turns.length - 1;
      if (last && this.dtmf) await this.sendDigits(this.dtmf);
      const nextBarges = !last && this.bargeInMs !== null;
      if (!nextBarges) await this.finishResponse();
    }
  }

  private async connect(): Promise<void> {
    const ws = new WebSocket(this.url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new SimulateCallError(`timed out connecting to ${this.url}`)));
      }, Math.min(10_000, this.remainingMs()));
      ws.once('open', () => finish(() => resolve()));
      ws.on('error', (err: Error) => {
        if (!settled) {
          finish(() => reject(new SimulateCallError(`failed to connect to ${this.url}: ${err.message}`)));
          return;
        }
        if (this.stopping || this.abortReason) return;
        this.socketError = err;
        this.triggerAbort('error');
      });
      ws.on('close', () => {
        if (this.stopping || this.abortReason) return;
        this.peerClosed = true;
        this.triggerAbort('peer');
      });
      ws.on('message', (data, isBinary) => {
        try {
          this.onMessage(data, isBinary);
        } catch (err) {
          debug(`message handler error ${(err as Error).message}`);
        }
      });
      this.abort.signal.addEventListener(
        'abort',
        () => finish(() => reject(this.abortError())),
        { once: true },
      );
    });
    this.playback = new Playback({
      underrunFloorMs: this.underrunFloorMs,
      utteranceSettleMs: UTTERANCE_SETTLE_MS,
      streamStartedAt: () => this.streamStartedAt,
      recording: this.recording,
      onMark: (name, reason) => this.echoMark(name, reason),
      onUtteranceStart: (now) => {
        this.utteranceStartedAt = now;
        this.noteResponseStart(now);
        debug('utterance start');
      },
      onUtteranceEnd: () => {
        this.utteranceStartedAt = null;
        const waiter = this.idleWaiter;
        this.idleWaiter = null;
        waiter?.();
        debug('utterance end');
      },
    });
  }

  private sendStart(): void {
    this.send(connectedMessage());
    this.send(
      startMessage({
        sequenceNumber: this.nextSeq(),
        streamSid: this.streamSid,
        callSid: this.callSid,
        accountSid: this.accountSid,
        customParameters: this.params,
      }),
    );
    this.streamStartedAt = performance.now();
    this.started = true;
  }

  private async sendCaller(turn: LiveTurn): Promise<void> {
    const start = performance.now();
    for (let i = 0; i < turn.frames.length; i += 1) {
      this.throwIfAborted();
      const jitter = this.jitterMs > 0 ? Math.random() * this.jitterMs : 0;
      await this.sleepUntil(start + i * FRAME_MS + jitter);
      const frame = turn.frames[i]!;
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
      this.recording.write(0, at - this.streamStartedAt, mulawToPcm16(frame));
    }
  }

  private async sendDigits(digits: string): Promise<void> {
    for (const digit of digits) {
      this.throwIfAborted();
      this.send({
        event: 'dtmf',
        streamSid: this.streamSid,
        sequenceNumber: this.nextSeq(),
        dtmf: { track: 'inbound_track', digit },
      });
      await this.sleep(160);
    }
  }

  private armResponseLatch(turn: LiveTurn): void {
    const now = performance.now();
    turn.endedAt = now;
    turn.waiting = true;
    this.latch = { after: now, startedAt: null, waiter: null };
    const started = this.utteranceStartedAt;
    const carriesOver = this.player().utteranceOpen && started !== null && started < this.turnStartedAt;
    if (this.player().utteranceOpen && started !== null && !carriesOver) {
      this.latch.startedAt = started;
      turn.firstAudioMs = Math.max(0, Math.round(started - now));
      turn.waiting = false;
    }
  }

  private async finishResponse(): Promise<void> {
    if (!this.player().isIdle()) await this.waitForIdle();
    if (this.latch?.startedAt != null) return;
    const graceEnd = Math.min(this.deadline(), performance.now() + this.responseGraceMs);
    const speechAt = await this.waitForSpeech(graceEnd);
    if (speechAt === null) return;
    await this.waitForIdle();
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.addProblem({
        kind: 'non-mulaw',
        detail: 'bot sent a binary WebSocket frame; Media Streams uses JSON text frames',
      });
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
    if (msg.kind === 'ignored') {
      this.unknownEvents += 1;
      return;
    }
    this.noteStreamSid(msg.streamSid);
    const now = performance.now();
    if (msg.kind === 'clear') {
      this.onClear(now);
      return;
    }
    if (msg.kind === 'mark') {
      this.marksReceived += 1;
      this.player().enqueueMark(msg.name, now);
      return;
    }
    if (msg.encoding && !/mulaw/i.test(msg.encoding)) {
      this.addProblem({ kind: 'non-mulaw', detail: `bot declared encoding ${msg.encoding}` });
    }
    const inspected = inspectMediaPayload(msg.payload);
    for (const problem of inspected.problems) this.addProblem(problem);
    if (!inspected.bytes) return;
    this.noteAudioAfterClear((inspected.bytes.length / SAMPLE_RATE) * 1000);
    this.player().enqueueAudio(mulawToPcm16(inspected.bytes), now);
  }

  private onClear(now: number): void {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]!;
      if (turn.barge && turn.interruptAt !== null && turn.clearAt === null) {
        turn.clearAt = now;
        debug(`clear ${Math.round(now - turn.interruptAt)} ms after interrupt`);
        break;
      }
    }
    this.player().clear(now);
  }

  private noteAudioAfterClear(durationMs: number): void {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]!;
      if (!turn.barge || turn.interruptAt === null) continue;
      if (turn.clearAt !== null && turn.endedAt === null) turn.botAudioAfterClearMs += durationMs;
      break;
    }
  }

  private noteResponseStart(now: number): void {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]!;
      if (!turn.waiting || turn.endedAt === null || turn.firstAudioMs !== null) continue;
      if (now < turn.endedAt) continue;
      turn.firstAudioMs = now - turn.endedAt;
      turn.waiting = false;
      break;
    }
    const latch = this.latch;
    if (latch && latch.startedAt === null && now >= latch.after) {
      latch.startedAt = now;
      const waiter = latch.waiter;
      latch.waiter = null;
      waiter?.(now);
    }
  }

  private noteStreamSid(streamSid: string | undefined): void {
    if (streamSid === undefined) {
      this.addProblem({ kind: 'missing-stream-sid', detail: 'bot message omitted streamSid' });
      return;
    }
    if (streamSid !== this.streamSid) {
      this.addProblem({
        kind: 'stream-sid-mismatch',
        detail: `bot streamSid ${streamSid} does not match ${this.streamSid}`,
      });
    }
  }

  private echoMark(name: string, reason: 'playback' | 'clear'): void {
    this.marksEchoed += 1;
    if (reason === 'clear') this.marksCleared += 1;
    else this.marksPlayed += 1;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.stopping) {
      debug(`drop mark echo ready=${this.ws?.readyState} stopping=${this.stopping}`);
      return;
    }
    debug(`echo mark ${name} (${reason})`);
    this.send({
      event: 'mark',
      sequenceNumber: this.nextSeq(),
      streamSid: this.streamSid,
      mark: { name },
    });
  }

  private waitForSpeech(until: number): Promise<number | null> {
    const latch = this.latch;
    if (!latch) return Promise.resolve(null);
    if (latch.startedAt !== null) return Promise.resolve(latch.startedAt);
    const remaining = until - performance.now();
    if (remaining <= 0) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', onAbort);
        if (latch.waiter) latch.waiter = null;
        fn();
      };
      const timer = setTimeout(() => finish(() => resolve(latch.startedAt)), remaining);
      const onAbort = (): void => finish(() => reject(this.abortError()));
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      latch.waiter = (at) => finish(() => resolve(at));
      if (latch.startedAt !== null) finish(() => resolve(latch.startedAt));
    });
  }

  private waitForIdle(): Promise<void> {
    if (this.player().isIdle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.abort.signal.removeEventListener('abort', onAbort);
        if (this.idleWaiter) this.idleWaiter = null;
        fn();
      };
      const onAbort = (): void => finish(() => reject(this.abortError()));
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      this.idleWaiter = () => finish(() => resolve());
      if (this.player().isIdle()) finish(() => resolve());
    });
  }

  private buildReport(): CallReport {
    const wav = this.recording.toWav();
    if (this.outPath) {
      mkdirSync(dirname(this.outPath), { recursive: true });
      writeFileSync(this.outPath, wav);
    }
    const gapsMs = (this.playback?.gapsMs ?? []).map((gap) => Math.round(gap));
    const durationMs = Math.max(0, Math.round(performance.now() - this.streamStartedAt));
    const draft: CallReport = {
      url: this.url,
      streamSid: this.streamSid,
      callSid: this.callSid,
      accountSid: this.accountSid,
      durationMs,
      timedOut: this.timedOut,
      peerClosed: this.peerClosed,
      turns: this.turns.map((turn) => ({
        turn: turn.index,
        label: turn.label,
        firstAudioMs: turn.firstAudioMs === null ? null : Math.round(turn.firstAudioMs),
      })),
      underruns: {
        count: gapsMs.length,
        longestGapMs: gapsMs.reduce((max, gap) => Math.max(max, gap), 0),
        gapsMs,
      },
      formatProblems: this.formatProblems,
      formatProblemCount: this.formatProblemCount,
      bargeIn: this.turns
        .filter((turn) => turn.barge)
        .map((turn) => ({
          turn: turn.index,
          clearReceived: turn.clearAt !== null,
          msToClear:
            turn.clearAt !== null && turn.interruptAt !== null ? Math.round(turn.clearAt - turn.interruptAt) : null,
          botAudioAfterClearMs: Math.round(turn.botAudioAfterClearMs),
        })),
      marksReceived: this.marksReceived,
      marksEchoed: this.marksEchoed,
      marksPlayed: this.marksPlayed,
      marksCleared: this.marksCleared,
      unknownEvents: this.unknownEvents,
      recording: {
        sampleRate: 8000,
        channels: 2,
        bitsPerSample: 16,
        layout: 'stereo-caller-left-bot-right',
        durationMs: Math.round(((wav.length - 44) / 4 / SAMPLE_RATE) * 1000),
        bytes: wav.length,
        ...(this.outPath ? { path: this.outPath } : {}),
      },
      recordingWav: wav,
      thresholds: this.thresholds,
      failures: [],
      ok: true,
    };
    const failures = [...this.extraFailures];
    if (this.timedOut) failures.unshift(`timed out after ${this.timeoutSec}s`);
    if (this.peerClosed) failures.push('bot closed the websocket before the stream stopped');
    if (this.abortedByCaller) failures.push('aborted');
    if (this.thresholds) failures.push(...evaluateThresholds(draft, this.thresholds));
    draft.failures = failures;
    draft.ok = failures.length === 0;
    return draft;
  }

  private resolveTurn(input: TurnInput, index: number): LiveTurn {
    const provided = [input.text !== undefined, input.wavPath !== undefined, input.mulaw !== undefined, input.pcm16 !== undefined].filter(Boolean).length;
    if (provided !== 1) {
      throw new SimulateCallError(`turn ${index + 1} needs exactly one of text, wavPath, mulaw, or pcm16`);
    }
    let pcm: Int16Array;
    let label = input.label;
    if (input.mulaw) {
      pcm = mulawToPcm16(input.mulaw);
      label ??= 'audio';
    } else if (input.pcm16) {
      const rate = input.sampleRate ?? SAMPLE_RATE;
      pcm = rate === SAMPLE_RATE ? input.pcm16 : resampleLinear(input.pcm16, rate, SAMPLE_RATE);
      label ??= 'audio';
    } else if (input.wavPath) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(input.wavPath);
      } catch (err) {
        throw new SimulateCallError(`cannot read ${input.wavPath}: ${(err as Error).message}`);
      }
      try {
        pcm = wavToMonoPcm8k(decodeWav(bytes));
      } catch (err) {
        throw new SimulateCallError(`cannot decode ${input.wavPath}: ${(err as Error).message}`);
      }
      label ??= basename(input.wavPath);
    } else {
      try {
        pcm = audioForText(input.text ?? '');
      } catch (err) {
        throw new SimulateCallError((err as Error).message);
      }
      label ??= input.text ?? 'audio';
    }
    const frames = pcmToFrames(pcm);
    if (frames.length === 0) throw new SimulateCallError(`turn ${index + 1} (${label}) has no audio`);
    return {
      index: index + 1,
      label,
      frames,
      barge: false,
      endedAt: null,
      firstAudioMs: null,
      waiting: false,
      interruptAt: null,
      clearAt: null,
      botAudioAfterClearMs: 0,
    };
  }

  private async shutdown(): Promise<void> {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    this.stopping = true;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.started) {
      await new Promise<void>((resolve) => {
        ws.send(
          JSON.stringify({
            event: 'stop',
            sequenceNumber: this.nextSeq(),
            streamSid: this.streamSid,
            stop: { accountSid: this.accountSid, callSid: this.callSid },
          }),
          () => resolve(),
        );
      });
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    // Let the bot observe the final mark/stop frames before this call resolves.
    await new Promise((resolve) => setImmediate(resolve));
    this.playback?.dispose();
  }

  private send(message: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new SimulateCallError('websocket closed before the stream finished');
    }
    this.ws.send(JSON.stringify(message));
  }

  private nextSeq(): string {
    this.sequence += 1;
    return String(this.sequence);
  }

  private addProblem(problem: FormatProblem): void {
    this.formatProblemCount += 1;
    if (this.formatProblems.length < 25) this.formatProblems.push(problem);
  }

  private triggerAbort(reason: AbortReason): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.abort.abort();
  }

  private recoverable(): boolean {
    return this.abortReason === 'timeout' || this.abortReason === 'peer' || this.abortReason === 'aborted';
  }

  private throwIfAborted(): void {
    if (this.abort.signal.aborted) throw this.abortError();
  }

  private abortError(): Error {
    const err = new Error(this.abortReason ?? 'aborted');
    err.name = 'CallAborted';
    return err;
  }

  private player(): Playback {
    if (!this.playback) throw new SimulateCallError('stream is not started');
    return this.playback;
  }

  private deadline(): number {
    return this.streamStartedAt + this.timeoutSec * 1000;
  }

  private remainingMs(): number {
    return Math.max(1, this.deadline() - performance.now());
  }

  private sleep(ms: number): Promise<void> {
    if (this.abort.signal.aborted) return Promise.reject(this.abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(this.abortError());
      };
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async sleepUntil(target: number): Promise<void> {
    const ms = target - performance.now();
    if (ms > 0) await this.sleep(ms);
  }
}

function normalizeUrl(url: string): string {
  try {
    return normalizeWsUrl(url);
  } catch (err) {
    throw new SimulateCallError((err as Error).message);
  }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
