import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { WriteStream } from 'node:fs';
import { optionalPackageVersion } from '../livekit/load.js';
import { createLiveKitTransport } from '../livekit/transport.js';
import { transcribePcm } from '../stt/transcribe.js';
import { createTwilioTransport } from '../twilio/transport.js';
import { StereoRecording } from '../recording.js';
import type {
  AgentAudioFrame,
  AgentVadEvent,
  CallerPlayout,
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
  SttConfig,
} from './types.js';
import { runVerify } from './verify.js';

/** How long to wait for the agent to start a reply. */
const REPLY_START_TIMEOUT_MS = 8_000;
/** How long one reply may run before the turn stops waiting for it to end. */
const REPLY_END_TIMEOUT_MS = 30_000;
/** Agent quiet that ends a reply. Agents pause ~300-400 ms between sentences. */
const DEFAULT_REPLY_QUIET_MS = 700;
/** How long to wait, after a reply ends, for its transcript to be final. */
const TRANSCRIPT_SETTLE_MS = 3_000;
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
  const timer = setTimeout(() => controller.abort(), scenario.timeout_ms ?? file.timeout_ms ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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

  const config = transportConfig(file);
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
  const runnerWarnings: string[] = [];
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
      stt: file.stt,
      nativeTranscript: transport.hasNativeTranscript(),
    });
    turns.push(outcome.turn);
    failures.push(...outcome.failures);
    runnerWarnings.push(...outcome.warnings);
    if (outcome.barge) bargeIn.push(outcome.barge);
    if (outcome.dtmf) dtmf.push(outcome.dtmf);
    if (outcome.callerLine) transcript.push(outcome.callerLine);
    if (turn.hangup) break;
  }

  for (const line of transcriptLines(speech.said)) transcript.push({ role: 'agent', ...line });
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

  const snapshot = transport.snapshot();
  const gapLimit = tightestGap(file.defaults?.max_gap_ms, scenario.turns);
  if (snapshot.twilio && gapLimit !== undefined && snapshot.twilio.underruns.longestGapMs > gapLimit) {
    failures.push(
      `longest playback gap ${snapshot.twilio.underruns.longestGapMs} ms exceeds ${gapLimit} ms (${snapshot.twilio.underruns.count} underruns)`,
    );
  }
  if (snapshot.twilio && snapshot.twilio.formatProblemCount > 0) {
    failures.push(`twilio format problems: ${snapshot.twilio.formatProblemCount}`);
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
    warnings: [...transport.warnings(), ...runnerWarnings],
    ...(snapshot.twilio ? { twilio: snapshot.twilio } : {}),
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
  stt?: SttConfig;
  nativeTranscript: boolean;
}

async function runTurn(ctx: TurnContext): Promise<{
  turn: ReportTurn;
  failures: string[];
  barge?: ReportBargeIn;
  dtmf?: ReportDtmf;
  callerLine?: ReportTranscriptLine;
  warnings: string[];
}> {
  const n = ctx.index + 1;
  const { turn, transport, speech, signal } = ctx;
  const windowStart = ctx.index === 0 ? 0 : transport.now();
  const callerAction = Boolean(turn.say || turn.audio || turn.dtmf);
  const expect = mergeExpectation(ctx.defaults, turn.expect, Boolean(turn.say || turn.audio));
  const silenceMs = turn.silence_ms ?? (ctx.index > 0 && turn.barge_in_after_ms === undefined ? (ctx.defaults?.silence_ms ?? 0) : 0);
  const quietMs = ctx.defaults?.reply_quiet_ms ?? DEFAULT_REPLY_QUIET_MS;
  const replyEnded = (from: number): boolean => speech.replyAfter(from, quietMs, transport.now())?.ended === true;

  if (turn.hangup) await transport.hangup();

  let bargeLanded = false;
  if (turn.barge_in_after_ms !== undefined) {
    bargeLanded = await waitUntil(() => speech.speaking, SPEAKING_TIMEOUT_MS, signal);
    if (bargeLanded && speech.speechStartedAtMs !== null) {
      const elapsed = transport.now() - speech.speechStartedAtMs;
      if (elapsed < turn.barge_in_after_ms) await sleep(turn.barge_in_after_ms - elapsed, signal);
    }
  } else if (!callerAction && turn.wait_ms === undefined && expect && !expect.agent_silent) {
    if (await waitUntil(() => speech.startedAfter(windowStart), REPLY_START_TIMEOUT_MS, signal)) {
      await waitUntil(() => replyEnded(windowStart), REPLY_END_TIMEOUT_MS, signal);
    }
  } else if (!speech.quietFor(quietMs, transport.now())) {
    await waitUntil(() => speech.quietFor(quietMs, transport.now()), REPLY_END_TIMEOUT_MS, signal);
    if (silenceMs > 0) await sleep(silenceMs, signal);
  } else if (silenceMs > 0) {
    await sleep(silenceMs, signal);
  }
  if (turn.wait_ms) await sleep(turn.wait_ms, signal);

  let caller: ReportTurn['caller'];
  let callerLine: ReportTranscriptLine | undefined;
  let bargeAt: number | undefined;
  let clearInfo: CallerPlayout['barge'] | undefined;
  if (ctx.clip) {
    const playout = await transport.playCallerAudio({ pcm: ctx.clip.pcm, sampleRate: ctx.clip.sampleRate });
    ctx.recording.write(0, playout.startedAtMs, resampleLinear(ctx.clip.pcm, ctx.clip.sampleRate, 8000));
    caller = {
      text: ctx.clip.text,
      audioMs: Math.round(playout.audioMs),
      startedAt: playout.startedAtMs,
      endedAt: playout.endedAtMs,
    };
    ctx.log({
      t: playout.endedAtMs,
      type: 'playout',
      audioMs: Math.round(playout.audioMs),
      wallMs: playout.endedAtMs - playout.startedAtMs,
      startedAt: playout.startedAtMs,
    });
    if (turn.barge_in_after_ms !== undefined) bargeAt = playout.startedAtMs;
    clearInfo = playout.barge;
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
    const reply = await waitForReply(speech, transport, afterMs, deferEnd, windowStart, quietMs, signal, ctx.nativeTranscript || Boolean(ctx.stt));
    firstAudioMs = reply.firstAudioMs;
    speechMs = reply.speechMs;
  }
  if (ctx.nativeTranscript && expect && !deferEnd) {
    const words = wordChecks(expect);
    // No agent audio in this turn means no agent text is coming.
    if (!speech.startedAfter(windowStart)) words.said = false;
    if (words.said || words.heard) {
      await waitUntil(() => {
        const now = transport.now();
        return (!words.said || speech.settled('said', windowStart, now)) && (!words.heard || speech.settled('heard', windowStart, now));
      }, TRANSCRIPT_SETTLE_MS, signal);
    }
  }

  if (ctx.stt && !ctx.nativeTranscript) {
    const agentAudio = speech.pcmBetween(windowStart, transport.now());
    if (agentAudio && agentAudio.pcm.length > 0) {
      const text = await transcribePcm(ctx.stt, agentAudio.pcm, agentAudio.sampleRate);
      if (text) speech.said.push({ text, final: true, atMs: transport.now() });
    }
    if (ctx.clip && ctx.clip.pcm.length > 0) {
      const text = await transcribePcm(ctx.stt, ctx.clip.pcm, ctx.clip.sampleRate);
      if (text) speech.heard.push({ text, final: true, atMs: caller?.startedAt ?? windowStart });
    }
  }

  const said = speech.text('said', windowStart, transport.now());
  const heard = speech.text('heard', windowStart, transport.now());
  const newAudio = callerAction ? speech.replyAfter(afterMs, quietMs, transport.now()) !== null : speech.startedAfter(windowStart);
  if (ctx.clip && caller) {
    const text = turn.say !== undefined ? ctx.clip.text : heard || ctx.clip.text;
    callerLine = { role: 'caller', text, ...(heard ? { heard } : {}), t: caller.startedAt ?? caller.endedAt };
  }
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
        transcript: ctx.nativeTranscript || ctx.stt ? 'available' : 'none',
        clear:
          turn.barge_in_after_ms !== undefined
            ? { received: clearInfo?.clearReceived === true, msToClear: clearInfo?.msToClear ?? null }
            : null,
      })
    : { checks: [], failures: [] as string[], skipped: [] as string[] };

  const bargeTypes = new Set(['max_yield_ms', 'max_agent_audio_after_barge_ms', 'require_clear', 'agent_silent_after_barge']);
  const bargeChecks = evaluated.checks.filter((check) => bargeTypes.has(check.type));
  const barge: ReportBargeIn | undefined =
    turn.barge_in_after_ms !== undefined
      ? {
          turn: n,
          yieldMs: yieldMs ?? 0,
          agentAudioAfterMs: agentAudioAfterMs ?? 0,
          ok: bargeChecks.every((check) => check.ok),
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
    warnings: evaluated.skipped.map((type) => `turn ${n}: ${type} skipped (no transcript)`),
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
  quietMs: number,
  signal: AbortSignal,
  waitForWords: boolean,
): Promise<{ firstAudioMs: number | null; speechMs: number | null }> {
  const started = await waitUntil(() => speech.replyAfter(afterMs, quietMs, transport.now()) !== null, REPLY_START_TIMEOUT_MS, signal);
  if (!started) return { firstAudioMs: null, speechMs: null };
  if (deferEnd && waitForWords) {
    // The next turn barges in, so score what has arrived while the agent is still talking.
    await waitUntil(() => {
      const now = transport.now();
      return speech.text('said', windowStart, now).trim() !== '' || speech.text('heard', windowStart, now).trim() !== '';
    }, 800, signal);
  }
  if (!deferEnd) {
    await waitUntil(() => speech.replyAfter(afterMs, quietMs, transport.now())?.ended === true, REPLY_END_TIMEOUT_MS, signal);
  }
  const reply = speech.replyAfter(afterMs, quietMs, transport.now());
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
  private frames: { atMs: number; durationMs: number; loud: boolean; pcm: Int16Array; sampleRate: number }[] = [];

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
      pcm: frame.pcm,
      sampleRate: frame.sampleRate,
    });
  }

  pcmBetween(from: number, to: number): { pcm: Int16Array; sampleRate: number } | null {
    const chosen = this.frames.filter((frame) => frame.atMs < to && frame.atMs + frame.durationMs > from);
    if (chosen.length === 0) return null;
    const sampleRate = chosen[0]!.sampleRate;
    let total = 0;
    const parts = chosen.map((frame) => {
      const pcm = frame.sampleRate === sampleRate ? frame.pcm : resampleLinear(frame.pcm, frame.sampleRate, sampleRate);
      total += pcm.length;
      return pcm;
    });
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
      pcm.set(part, offset);
      offset += part.length;
    }
    return { pcm, sampleRate };
  }

  startedAfter(ms: number): boolean {
    return this.starts.some((item) => item.atMs >= ms - 30) || (this.speaking && (this.speechStartedAtMs ?? -1) >= ms - 30);
  }

  /** True once the agent has made no sound for `quietMs`. */
  quietFor(quietMs: number, now: number): boolean {
    if (this.speaking) return false;
    const last = this.stops[this.stops.length - 1];
    return !last || now - last.atMs >= quietMs;
  }

  /**
   * The first reply that started at or after `ms`. A reply is every utterance
   * from that start until the agent stays quiet for `quietMs`, so the pause
   * between two sentences does not end it.
   */
  replyAfter(ms: number, quietMs: number, now: number): { startMs: number; speechMs: number | null; ended: boolean } | null {
    const start = this.starts.find((item) => item.atMs >= ms - 30);
    if (!start) return null;
    const stops = this.stops.filter((item) => item.startMs >= start.atMs - 5);
    const speechMs = stops.length > 0 ? stops.reduce((sum, item) => sum + item.speechMs, 0) : null;
    return { startMs: start.atMs, speechMs, ended: stops.length > 0 && this.quietFor(quietMs, now) };
  }

  /** Some text has arrived since `from`, and no segment in it is still open. */
  settled(which: 'said' | 'heard', from: number, to: number): boolean {
    const events = (which === 'said' ? this.said : this.heard).filter((event) => event.atMs >= from - 30 && event.atMs <= to + 30);
    if (!events.some((event) => event.text.trim())) return false;
    const open = new Map<string, boolean>();
    for (const event of events) if (event.segmentId) open.set(event.segmentId, open.get(event.segmentId) === false ? false : !event.final);
    return ![...open.values()].some(Boolean);
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

/** What to score from `expect`: the agent's own words, what it heard, or both. */
function wordChecks(expect: ScenarioTurn['expect']): { said: boolean; heard: boolean } {
  return {
    said: Boolean(expect?.agent_says_any || expect?.agent_says_all || expect?.agent_says_regex || expect?.agent_not_says),
    heard: Boolean(expect?.agent_heard),
  };
}

/** One line per segment (its final text, else the latest), timed by when the segment began. */
function transcriptLines(events: TranscriptEvent[]): { text: string; t: number }[] {
  const lines: { text: string; t: number; final: boolean }[] = [];
  const bySegment = new Map<string, { text: string; t: number; final: boolean }>();
  for (const event of events) {
    const text = event.text.trim();
    if (!event.segmentId) {
      if (text) lines.push({ text, t: event.atMs, final: event.final });
      continue;
    }
    const line = bySegment.get(event.segmentId);
    if (!line) {
      const created = { text, t: event.atMs, final: event.final };
      bySegment.set(event.segmentId, created);
      lines.push(created);
    } else if (!line.final) {
      line.text = text;
      line.final = event.final;
    }
  }
  return lines.filter((line) => line.text).map(({ text, t }) => ({ text, t }));
}

/** Text for one turn. A segment belongs to the turn it started in, even when its final text lands later. */
function joinTranscript(events: TranscriptEvent[], from: number, to: number): string {
  const inWindow = (t: number): boolean => t >= from - 30 && t <= to + 30;
  const plain = events.filter((event) => !event.segmentId && inWindow(event.atMs));
  const finals = plain.filter((event) => event.final);
  const lines = [
    ...transcriptLines(events.filter((event) => event.segmentId)).filter((line) => inWindow(line.t)),
    ...(finals.length > 0 ? finals : plain).map((event) => ({ text: event.text.trim(), t: event.atMs })),
  ];
  return lines
    .sort((a, b) => a.t - b.t)
    .map((line) => line.text)
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
  if (name === 'twilio') return createTwilioTransport();
  throw new ScenarioUsageError(`Unknown transport "${name}"`);
}

function transportConfig(file: ScenarioFile): Record<string, unknown> {
  if (file.transport === 'livekit') return { ...(file.livekit ?? {}) } as Record<string, unknown>;
  if (file.transport === 'twilio') return { ...(file.twilio ?? {}) } as Record<string, unknown>;
  return {};
}

function tightestGap(fromDefaults: number | undefined, turns: ScenarioTurn[]): number | undefined {
  let limit = fromDefaults;
  for (const turn of turns) {
    const value = turn.expect?.max_gap_ms;
    if (value === undefined) continue;
    limit = limit === undefined ? value : Math.min(limit, value);
  }
  return limit;
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
