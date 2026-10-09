import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { WriteStream } from 'node:fs';
import { optionalPackageVersion } from '../livekit/load.js';
import { createLiveKitTransport } from '../livekit/transport.js';
import { StereoRecording } from '../recording.js';
import type {
  AgentAudioFrame,
  AgentVadEvent,
  TranscriptEvent,
  Transport,
  TransportLogEvent,
} from '../transport.js';
import { ENERGY_VAD_PEAK } from '../vad.js';
import { packageVersion } from '../version.js';
import { resampleLinear } from '../wav.js';
import { prepareTurnAudio, type PreparedClip } from './audio.js';
import { ScenarioConnectionError, ScenarioUsageError, scrubSecrets } from './errors.js';
import { evaluateExpectations, expectsSpeech, mergeExpectation, percentile } from './expect.js';
import { runJudge } from './judge.js';
import { loadScenarioFiles } from './load.js';
import type {
  ReportBargeIn,
  ReportDtmf,
  ReportTranscriptLine,
  ReportTurn,
  ScenarioCase,
  ScenarioFile,
  ScenarioReport,
  ScenarioTurn,
} from './types.js';
import { runVerify } from './verify.js';

const REPLY_TIMEOUT_MS = 4_000;
const GREETING_TIMEOUT_MS = 8_000;
const YIELD_TIMEOUT_MS = 8_000;
const SPEAKING_TIMEOUT_MS = 10_000;
const STATE_GRACE_MS = 300;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunScenariosOptions {
  files: string[];
  cwd?: string;
  labels?: string[];
  tags?: Record<string, string>;
  judgeRequired?: boolean;
  timeoutMs?: number;
  outDir?: string;
  transportFactory?: (name: string) => Transport;
}

export async function runScenarios(options: RunScenariosOptions): Promise<ScenarioReport[]> {
  const cwd = options.cwd ?? process.cwd();
  const files = loadScenarioFiles(options.files, cwd);
  const selected = files.flatMap((file) =>
    file.scenarios.filter((scenario) => matches(scenario, options.labels, options.tags)).map((scenario) => ({ file, scenario })),
  );
  if (selected.length === 0) throw new ScenarioUsageError('No scenarios matched the label and tag filters');
  const reports: ScenarioReport[] = [];
  for (const item of selected) reports.push(await runOne(item.file, item.scenario, options, cwd));
  return reports;
}

export function scenarioExitCode(reports: ScenarioReport[]): number {
  if (reports.some((report) => report.error?.exitCode === 2)) return 2;
  if (reports.some((report) => !report.ok)) return 1;
  return 0;
}

async function runOne(file: ScenarioFile, scenario: ScenarioCase, options: RunScenariosOptions, cwd: string): Promise<ScenarioReport> {
  const runId = makeRunId();
  const runDir = join(options.outDir ?? join(cwd, '.callsim', 'runs'), runId);
  mkdirSync(runDir, { recursive: true });
  const eventsPath = join(runDir, 'events.jsonl');
  const wavPath = join(runDir, 'call.wav');
  const events = createWriteStream(eventsPath, { flags: 'a' });
  const log = (event: TransportLogEvent): void => {
    events.write(`${JSON.stringify(event)}\n`);
    if (process.env.CALLSIM_DEBUG) process.stderr.write(`${JSON.stringify(event)}\n`);
  };
  const started = Date.now();
  const base = blankReport(file, scenario, runId, cwd, runDir);
  let report = base;
  let transport: Transport | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    transport = (options.transportFactory ?? defaultTransport)(file.transport);
    const clips = new Map<number, PreparedClip>();
    for (let i = 0; i < scenario.turns.length; i += 1) {
      const clip = await prepareTurnAudio(scenario.turns[i]!, file.dir, file.voice, cwd);
      if (clip) clips.set(i, clip);
    }
    report = await runConnected({
      file,
      scenario,
      transport,
      clips,
      signal: controller.signal,
      log,
      base,
      wavPath,
      runDir,
      cwd,
      judgeRequired: options.judgeRequired === true,
    });
  } catch (err) {
    report = {
      ...base,
      ok: false,
      durationMs: Date.now() - started,
      failures: [scrubSecrets(err instanceof Error ? err.message : String(err))],
      warnings: [...(transport?.warnings() ?? [])],
      ...(transport?.roomId() ? { room: transport.roomId() } : {}),
      error: errorInfo(err),
    };
  } finally {
    clearTimeout(timer);
    await transport?.hangup().catch(() => undefined);
    report.durationMs = report.durationMs ?? Date.now() - started;
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    await finished(events);
  }
  return report;
}

interface ConnectedArgs {
  file: ScenarioFile;
  scenario: ScenarioCase;
  transport: Transport;
  clips: Map<number, PreparedClip>;
  signal: AbortSignal;
  log: (event: TransportLogEvent) => void;
  base: ScenarioReport;
  wavPath: string;
  runDir: string;
  cwd: string;
  judgeRequired: boolean;
}

async function runConnected(args: ConnectedArgs): Promise<ScenarioReport> {
  const { file, scenario, transport, signal, log } = args;
  const speech = new SpeechLog();
  const recording = new StereoRecording();
  let caller: ScenarioReport['caller'];
  transport.onAgentVad((event) => {
    speech.vad(event);
    log({ t: event.atMs, type: 'vad', vad: event.type, ...(event.speechMs !== undefined ? { speechMs: event.speechMs } : {}) });
  });
  transport.onAgentTranscript((event) => {
    speech.said.push(event);
    log({ t: event.atMs, type: 'agent_transcript', text: event.text, final: event.final });
  });
  transport.onCallerHeard((event) => {
    speech.heard.push(event);
    log({ t: event.atMs, type: 'caller_heard', text: event.text, final: event.final });
  });
  transport.onAgentAudio((frame) => {
    recording.write(1, frame.atMs, resampleLinear(frame.pcm, frame.sampleRate, 8000));
    speech.noteFrame(frame);
  });

  const config = file.transport === 'livekit' ? ({ ...(file.livekit ?? {}) } as Record<string, unknown>) : {};
  await transport.connect({
    runId: args.base.runId,
    label: scenario.label,
    config,
    ...(scenario.userdata !== undefined ? { userdata: scenario.userdata } : {}),
    signal,
    onEvent: (event) => {
      log(event);
      if (event.type === 'caller') {
        caller = {
          identity: String(event.identity ?? ''),
          kind: String(event.kind ?? ''),
          requestedKind: String(event.requestedKind ?? ''),
        };
      }
    },
  });
  throwIfAborted(signal);
  const agent = await transport.waitForAgent(file.livekit?.join_timeout_ms ?? 15_000);
  log({ t: agent.joinedMs, type: 'agent_joined', identity: agent.identity });

  const turns: ReportTurn[] = [];
  const failures: string[] = [];
  const bargeIn: ReportBargeIn[] = [];
  const dtmf: ReportDtmf[] = [];
  const transcript: ReportTranscriptLine[] = [];

  for (let index = 0; index < scenario.turns.length; index += 1) {
    throwIfAborted(signal);
    const turn = scenario.turns[index]!;
    if (turn.barge_in_after_ms !== undefined && speech.speaking && turns.length > 0) {
      turns[turns.length - 1]!.agent.interrupted = true;
    }
    const outcome = await runTurn({
      turn,
      index,
      next: scenario.turns[index + 1],
      defaults: file.defaults,
      clip: args.clips.get(index),
      transport,
      speech,
      recording,
      signal,
      log,
    });
    turns.push(outcome.turn);
    failures.push(...outcome.failures);
    if (outcome.barge) bargeIn.push(outcome.barge);
    if (outcome.dtmf) dtmf.push(outcome.dtmf);
    if (outcome.callerLine) transcript.push(outcome.callerLine);
    if (turn.hangup) break;
  }

  for (const event of speech.said) {
    if (event.segmentId && !event.final) continue;
    if (event.text.trim()) transcript.push({ role: 'agent', text: event.text.trim(), t: event.atMs });
  }
  transcript.sort((a, b) => a.t - b.t);

  const judge = scenario.judge ? await runJudge(scenario.judge, transcript) : undefined;
  if (judge && args.judgeRequired && (judge.skipped || judge.ok !== true)) {
    failures.push(`judge: ${judge.reason ?? 'not ok'}`);
  }

  let verify: ScenarioReport['verify'];
  if (scenario.verify) {
    const result = await runVerify(scenario.verify, args.cwd);
    verify = { ran: result.ran, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) };
    failures.push(...result.failures);
  }

  writeFileSync(args.wavPath, recording.toWav());
  const samples = turns.map((turn) => turn.agent.firstAudioMs).filter((value): value is number => value !== null);
  const rtcNode = file.transport === 'livekit' ? optionalPackageVersion('@livekit/rtc-node') : undefined;
  return {
    ...args.base,
    ...(transport.roomId() ? { room: transport.roomId() } : {}),
    agent: { identity: agent.identity, joinedMs: agent.joinedMs },
    ...(caller ? { caller } : {}),
    ok: failures.length === 0,
    failures,
    warnings: [...transport.warnings()],
    turns,
    bargeIn,
    dtmf,
    ...(samples.length > 0
      ? { latency: { firstAudioMs: { p50: percentile(samples, 50), p95: percentile(samples, 95), max: Math.max(...samples) } } }
      : {}),
    ...(judge ? { judge } : {}),
    ...(verify ? { verify } : {}),
    transcript,
    artifacts: { wav: relFrom(args.cwd, args.wavPath), events: relFrom(args.cwd, join(args.runDir, 'events.jsonl')) },
    versions: { callsim: packageVersion(), ...(rtcNode ? { rtcNode } : {}) },
    durationMs: transport.now(),
  };
}

interface TurnContext {
  turn: ScenarioTurn;
  index: number;
  next: ScenarioTurn | undefined;
  defaults: ScenarioFile['defaults'];
  clip: PreparedClip | undefined;
  transport: Transport;
  speech: SpeechLog;
  recording: StereoRecording;
  signal: AbortSignal;
  log: (event: TransportLogEvent) => void;
}

async function runTurn(ctx: TurnContext): Promise<{
  turn: ReportTurn;
  failures: string[];
  barge?: ReportBargeIn;
  dtmf?: ReportDtmf;
  callerLine?: ReportTranscriptLine;
}> {
  const n = ctx.index + 1;
  const { turn, transport, speech, signal } = ctx;
  const windowStart = ctx.index === 0 ? 0 : transport.now();
  const callerAction = Boolean(turn.say || turn.audio || turn.dtmf);
  const expect = mergeExpectation(ctx.defaults, turn.expect, callerAction);
  const silenceMs = turn.silence_ms ?? (ctx.index > 0 && turn.barge_in_after_ms === undefined ? (ctx.defaults?.silence_ms ?? 0) : 0);

  if (turn.hangup) await transport.hangup();

  let bargeLanded = false;
  if (turn.barge_in_after_ms !== undefined) {
    bargeLanded = await waitUntil(() => speech.speaking, SPEAKING_TIMEOUT_MS, signal);
    if (bargeLanded && speech.speechStartedAtMs !== null) {
      const elapsed = transport.now() - speech.speechStartedAtMs;
      if (elapsed < turn.barge_in_after_ms) await sleep(turn.barge_in_after_ms - elapsed, signal);
    }
  } else if (!callerAction && turn.wait_ms === undefined && expect && !expect.agent_silent) {
    await waitUntil(() => speech.startedAfter(windowStart), GREETING_TIMEOUT_MS, signal);
    await waitUntil(() => speech.endedAfter(windowStart), GREETING_TIMEOUT_MS, signal);
  } else if (speech.speaking) {
    await waitUntil(() => !speech.speaking, SPEAKING_TIMEOUT_MS, signal);
    if (silenceMs > 0) await sleep(silenceMs, signal);
  } else if (silenceMs > 0) {
    await sleep(silenceMs, signal);
  }
  if (turn.wait_ms) await sleep(turn.wait_ms, signal);

  let caller: ReportTurn['caller'];
  let callerLine: ReportTranscriptLine | undefined;
  let bargeAt: number | undefined;
  if (ctx.clip) {
    const playout = await transport.playCallerAudio({ pcm: ctx.clip.pcm, sampleRate: ctx.clip.sampleRate });
    ctx.recording.write(0, playout.startedAtMs, resampleLinear(ctx.clip.pcm, ctx.clip.sampleRate, 8000));
    caller = {
      text: ctx.clip.text,
      audioMs: Math.round(playout.audioMs),
      startedAt: playout.startedAtMs,
      endedAt: playout.endedAtMs,
    };
    callerLine = { role: 'caller', text: ctx.clip.text, t: playout.startedAtMs };
    ctx.log({
      t: playout.endedAtMs,
      type: 'playout',
      audioMs: Math.round(playout.audioMs),
      wallMs: playout.endedAtMs - playout.startedAtMs,
      startedAt: playout.startedAtMs,
    });
    if (turn.barge_in_after_ms !== undefined) bargeAt = playout.startedAtMs;
  }

  let dtmf: ReportDtmf | undefined;
  if (turn.dtmf) {
    await transport.sendDtmf(turn.dtmf);
    dtmf = { turn: n, digits: turn.dtmf };
    ctx.log({ t: transport.now(), type: 'dtmf', digits: turn.dtmf });
  }

  let yieldMs: number | null = null;
  let agentAudioAfterMs: number | null = null;
  if (turn.barge_in_after_ms !== undefined && bargeLanded && bargeAt !== undefined) {
    const measured = await measureYield(speech, transport, bargeAt, signal);
    yieldMs = measured.yieldMs;
    agentAudioAfterMs = measured.agentAudioAfterMs;
  }

  const afterMs = caller?.endedAt ?? transport.now();
  let firstAudioMs: number | null = null;
  let speechMs: number | null = null;
  const deferEnd = ctx.next?.barge_in_after_ms !== undefined;
  if (expect?.agent_silent) {
    await sleep(Math.max(silenceMs, 800), signal);
  } else if (callerAction && expect && expectsSpeech(expect)) {
    const reply = await waitForReply(speech, transport, afterMs, deferEnd, windowStart, signal);
    firstAudioMs = reply.firstAudioMs;
    speechMs = reply.speechMs;
  }

  const said = speech.text('said', windowStart, transport.now());
  const heard = speech.text('heard', windowStart, transport.now());
  const newAudio = callerAction ? speech.replyAfter(afterMs) !== null : speech.startedAfter(windowStart);
  const evaluated = expect
    ? evaluateExpectations({
        turn: n,
        expect,
        said,
        heard,
        firstAudioMs: callerAction ? firstAudioMs : null,
        barged: turn.barge_in_after_ms !== undefined,
        yieldMs,
        agentAudioAfterMs,
        newAudio,
      })
    : { checks: [], failures: [] as string[] };

  const yieldChecks = evaluated.checks.filter((check) => check.type === 'max_yield_ms' || check.type === 'max_agent_audio_after_barge_ms');
  const barge: ReportBargeIn | undefined =
    turn.barge_in_after_ms !== undefined
      ? {
          turn: n,
          yieldMs: yieldMs ?? 0,
          agentAudioAfterMs: agentAudioAfterMs ?? 0,
          ok: yieldChecks.every((check) => check.ok),
        }
      : undefined;

  return {
    turn: {
      i: n,
      ...(caller ? { caller } : {}),
      agent: {
        said,
        heard,
        firstAudioMs: callerAction ? firstAudioMs : null,
        speechMs,
        interrupted: false,
      },
      checks: evaluated.checks,
    },
    failures: evaluated.failures,
    ...(barge ? { barge } : {}),
    ...(dtmf ? { dtmf } : {}),
    ...(callerLine ? { callerLine } : {}),
  };
}

async function measureYield(
  speech: SpeechLog,
  transport: Transport,
  bargeAt: number,
  signal: AbortSignal,
): Promise<{ yieldMs: number; agentAudioAfterMs: number }> {
  await waitUntil(
    () => speech.stops.some((item) => item.atMs >= bargeAt - 20 && item.startMs <= bargeAt + 50),
    YIELD_TIMEOUT_MS,
    signal,
  );
  const stateDeadline = Date.now() + STATE_GRACE_MS;
  while (transport.agentState() === 'speaking' && Date.now() < stateDeadline) await sleep(20, signal);
  const stop = speech.stops.find((item) => item.atMs >= bargeAt - 20 && item.startMs <= bargeAt + 50);
  const stopAt = stop?.atMs ?? transport.now();
  return {
    yieldMs: Math.max(0, Math.round(stopAt - bargeAt)),
    agentAudioAfterMs: speech.loudMsBetween(bargeAt, stopAt),
  };
}

async function waitForReply(
  speech: SpeechLog,
  transport: Transport,
  afterMs: number,
  deferEnd: boolean,
  windowStart: number,
  signal: AbortSignal,
): Promise<{ firstAudioMs: number | null; speechMs: number | null }> {
  const started = await waitUntil(() => speech.replyAfter(afterMs) !== null, REPLY_TIMEOUT_MS, signal);
  if (!started) return { firstAudioMs: null, speechMs: null };
  await waitUntil(() => {
    const now = transport.now();
    return speech.text('said', windowStart, now).trim() !== '' || speech.text('heard', windowStart, now).trim() !== '';
  }, 800, signal);
  if (!deferEnd) await waitUntil(() => speech.replyAfter(afterMs)?.ended === true, REPLY_TIMEOUT_MS, signal);
  const reply = speech.replyAfter(afterMs);
  return {
    firstAudioMs: reply ? Math.max(0, Math.round(reply.startMs - afterMs)) : null,
    speechMs: reply?.speechMs ?? null,
  };
}

class SpeechLog {
  starts: { atMs: number }[] = [];
  stops: { atMs: number; speechMs: number; startMs: number }[] = [];
  speaking = false;
  speechStartedAtMs: number | null = null;
  said: TranscriptEvent[] = [];
  heard: TranscriptEvent[] = [];
  private frames: { atMs: number; durationMs: number; loud: boolean }[] = [];

  vad(event: AgentVadEvent): void {
    if (event.type === 'start') {
      this.speaking = true;
      this.speechStartedAtMs = event.atMs;
      this.starts.push({ atMs: event.atMs });
      return;
    }
    const startMs = this.speechStartedAtMs ?? event.atMs;
    this.speaking = false;
    this.speechStartedAtMs = null;
    this.stops.push({
      atMs: event.atMs,
      speechMs: event.speechMs ?? Math.max(0, event.atMs - startMs),
      startMs,
    });
  }

  noteFrame(frame: AgentAudioFrame): void {
    let peak = 0;
    for (let i = 0; i < frame.pcm.length; i += 1) peak = Math.max(peak, Math.abs(frame.pcm[i] ?? 0));
    this.frames.push({
      atMs: frame.atMs,
      durationMs: (frame.pcm.length / frame.sampleRate) * 1000,
      loud: peak >= ENERGY_VAD_PEAK,
    });
  }

  startedAfter(ms: number): boolean {
    return this.starts.some((item) => item.atMs >= ms - 30) || (this.speaking && (this.speechStartedAtMs ?? -1) >= ms - 30);
  }

  endedAfter(ms: number): boolean {
    return this.stops.some((item) => item.startMs >= ms - 30);
  }

  replyAfter(ms: number): { startMs: number; speechMs: number | null; ended: boolean } | null {
    const start = this.starts.find((item) => item.atMs >= ms - 30);
    if (!start) return null;
    const stop = this.stops.find((item) => item.startMs >= start.atMs - 5);
    return { startMs: start.atMs, speechMs: stop?.speechMs ?? null, ended: Boolean(stop) };
  }

  loudMsBetween(from: number, to: number): number {
    let total = 0;
    for (const frame of this.frames) {
      if (!frame.loud) continue;
      const start = Math.max(frame.atMs, from);
      const end = Math.min(frame.atMs + frame.durationMs, to);
      if (end > start) total += end - start;
    }
    return Math.round(total);
  }

  text(which: 'said' | 'heard', from: number, to: number): string {
    return joinTranscript(which === 'said' ? this.said : this.heard, from, to);
  }
}

function joinTranscript(events: TranscriptEvent[], from: number, to: number): string {
  const window = events.filter((event) => event.atMs >= from - 30 && event.atMs <= to + 30);
  const bySegment = new Map<string, TranscriptEvent>();
  const plain: TranscriptEvent[] = [];
  for (const event of window) {
    if (!event.segmentId) {
      plain.push(event);
      continue;
    }
    const prev = bySegment.get(event.segmentId);
    if (!prev || event.final || (!prev.final && event.atMs >= prev.atMs)) bySegment.set(event.segmentId, event);
  }
  const all = [...bySegment.values(), ...plain];
  const finals = all.filter((event) => event.final);
  const use = (finals.length > 0 ? finals : all).sort((a, b) => a.atMs - b.atMs);
  return use
    .map((event) => event.text.trim())
    .filter(Boolean)
    .join(' ');
}

function blankReport(file: ScenarioFile, scenario: ScenarioCase, runId: string, cwd: string, runDir: string): ScenarioReport {
  const rtcNode = file.transport === 'livekit' ? optionalPackageVersion('@livekit/rtc-node') : undefined;
  return {
    schema: 'callsim.report/1',
    runId,
    scenario: scenario.label,
    file: relFrom(cwd, file.path),
    transport: file.transport,
    ok: false,
    failures: [],
    warnings: [],
    turns: [],
    bargeIn: [],
    dtmf: [],
    transcript: [],
    artifacts: { events: relFrom(cwd, join(runDir, 'events.jsonl')) },
    versions: { callsim: packageVersion(), ...(rtcNode ? { rtcNode } : {}) },
  };
}

function defaultTransport(name: string): Transport {
  if (name === 'livekit') return createLiveKitTransport();
  if (name === 'twilio') {
    throw new ScenarioUsageError(
      'transport: twilio is not on the scenario runner yet. Use `callsim <ws-url>` for Twilio Media Streams.',
    );
  }
  throw new ScenarioUsageError(`Unknown transport "${name}"`);
}

function matches(scenario: ScenarioCase, labels: string[] | undefined, tags: Record<string, string> | undefined): boolean {
  if (labels && labels.length > 0 && !labels.includes(scenario.label)) return false;
  if (tags) {
    for (const [key, value] of Object.entries(tags)) {
      if ((scenario.tags?.[key] ?? '') !== value) return false;
    }
  }
  return true;
}

function errorInfo(err: unknown): NonNullable<ScenarioReport['error']> {
  if (err instanceof ScenarioUsageError) return { code: 'usage', message: err.message, exitCode: 2 };
  if (err instanceof ScenarioConnectionError) return { code: err.code, message: err.message, exitCode: 2 };
  if (err instanceof ScenarioTimeoutError) return { code: 'timeout', message: err.message, exitCode: 1 };
  return { code: 'error', message: scrubSecrets(err instanceof Error ? err.message : String(err)), exitCode: 2 };
}

class ScenarioTimeoutError extends Error {
  readonly exitCode = 1 as const;
  constructor() {
    super('scenario timed out');
    this.name = 'ScenarioTimeoutError';
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ScenarioTimeoutError();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ScenarioTimeoutError());
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new ScenarioTimeoutError());
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitUntil(pred: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (pred()) return true;
    await sleep(20, signal);
  }
  return pred();
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function relFrom(cwd: string, path: string): string {
  const value = relative(cwd, path);
  return (value || path).split('\\').join('/');
}

function finished(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}
