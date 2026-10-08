#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CI_DEFAULT_MAX_FIRST_AUDIO_MS,
  CI_DEFAULT_MAX_GAP_MS,
  DEFAULT_SILENCE_SEC,
  DEFAULT_TIMEOUT_SEC,
} from './constants.js';
import { formatReport } from './report.js';
import { SimulateCallError, simulateCall } from './simulate.js';
import { reportJson } from './thresholds.js';
import type { Thresholds, TurnInput } from './types.js';
import { packageVersion } from './version.js';

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color?: boolean;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

interface ParsedCli {
  help: boolean;
  version: boolean;
  url?: string;
  turns: TurnInput[];
  bargeIn?: number;
  silence?: number;
  timeout?: number;
  params: Record<string, string>;
  dtmf?: string;
  jitter?: number;
  out?: string;
  json: boolean;
  ci: boolean;
  thresholds: Thresholds | null;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      io.stdout(helpText());
      return 0;
    }
    if (args.version) {
      io.stdout(`voice-callsim ${packageVersion()}\n`);
      return 0;
    }
    if (!args.url) throw new CliError('Missing WebSocket URL.\n\n' + helpText());
    const report = await simulateCall({
      url: args.url,
      turns: args.turns,
      ...(args.bargeIn !== undefined ? { bargeIn: args.bargeIn } : {}),
      ...(args.silence !== undefined ? { silence: args.silence } : {}),
      ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
      ...(Object.keys(args.params).length > 0 ? { params: args.params } : {}),
      ...(args.dtmf !== undefined ? { dtmf: args.dtmf } : {}),
      ...(args.jitter !== undefined ? { jitter: args.jitter } : {}),
      ...(args.out !== undefined ? { out: args.out } : {}),
      ...(args.thresholds ? { thresholds: args.thresholds } : {}),
    });
    if (args.json) io.stdout(`${JSON.stringify(reportJson(report), null, 2)}\n`);
    else io.stdout(`${formatReport(report, useColor(io, args.json))}\n`);
    if (report.timedOut || report.peerClosed) return 1;
    if (args.ci && !report.ok) return 1;
    return 0;
  } catch (err) {
    if (err instanceof CliError || err instanceof SimulateCallError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

export function parseArgs(argv: string[]): ParsedCli {
  const turns: TurnInput[] = [];
  const positional: string[] = [];
  const params: Record<string, string> = {};
  let help = false;
  let version = false;
  let json = false;
  let ci = false;
  let requireBargeIn = false;
  let sawThreshold = false;
  let bargeIn: number | undefined;
  let silence: number | undefined;
  let timeout: number | undefined;
  let dtmf: string | undefined;
  let jitter: number | undefined;
  let out: string | undefined;
  let maxFirstAudioMs: number | undefined;
  let maxGapMs: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      version = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--ci') {
      ci = true;
      continue;
    }
    if (arg === '--require-barge-in') {
      requireBargeIn = true;
      sawThreshold = true;
      continue;
    }
    const say = take(argv, i, arg, '--say');
    if (say) {
      if (!say.value.trim()) throw new CliError('--say requires text');
      turns.push({ text: say.value });
      i = say.next;
      continue;
    }
    const audio = take(argv, i, arg, '--audio');
    if (audio) {
      turns.push({ wavPath: audio.value, label: basename(audio.value) });
      i = audio.next;
      continue;
    }
    const barge = take(argv, i, arg, '--barge-in');
    if (barge) {
      bargeIn = numberFlag('--barge-in', barge.value);
      i = barge.next;
      continue;
    }
    const silenceFlag = take(argv, i, arg, '--silence');
    if (silenceFlag) {
      silence = numberFlag('--silence', silenceFlag.value);
      i = silenceFlag.next;
      continue;
    }
    const timeoutFlag = take(argv, i, arg, '--timeout');
    if (timeoutFlag) {
      timeout = numberFlag('--timeout', timeoutFlag.value, true);
      i = timeoutFlag.next;
      continue;
    }
    const param = take(argv, i, arg, '--param');
    if (param) {
      const eq = param.value.indexOf('=');
      if (eq <= 0) throw new CliError('--param expects key=value');
      params[param.value.slice(0, eq)] = param.value.slice(eq + 1);
      i = param.next;
      continue;
    }
    const dtmfFlag = take(argv, i, arg, '--dtmf');
    if (dtmfFlag) {
      if (!/^[0-9*#]+$/.test(dtmfFlag.value)) throw new CliError('--dtmf must contain only 0-9, *, and #');
      dtmf = dtmfFlag.value;
      i = dtmfFlag.next;
      continue;
    }
    const jitterFlag = take(argv, i, arg, '--jitter');
    if (jitterFlag) {
      jitter = numberFlag('--jitter', jitterFlag.value);
      i = jitterFlag.next;
      continue;
    }
    const outFlag = take(argv, i, arg, '--out');
    if (outFlag) {
      out = outFlag.value;
      i = outFlag.next;
      continue;
    }
    const first = take(argv, i, arg, '--max-first-audio-ms');
    if (first) {
      maxFirstAudioMs = numberFlag('--max-first-audio-ms', first.value);
      sawThreshold = true;
      i = first.next;
      continue;
    }
    const gap = take(argv, i, arg, '--max-gap-ms');
    if (gap) {
      maxGapMs = numberFlag('--max-gap-ms', gap.value);
      sawThreshold = true;
      i = gap.next;
      continue;
    }
    if (arg.startsWith('--')) throw new CliError(`Unknown option ${arg}.\n\n${helpText()}`);
    positional.push(arg);
  }

  if (positional.length > 1) throw new CliError('Expected a single WebSocket URL.');
  let callerTurns = turns;
  if (bargeIn !== undefined && callerTurns.length === 1) callerTurns = [callerTurns[0]!, { ...callerTurns[0]! }];

  let thresholds: Thresholds | null = null;
  if (ci && !sawThreshold) {
    thresholds = {
      maxFirstAudioMs: CI_DEFAULT_MAX_FIRST_AUDIO_MS,
      maxGapMs: CI_DEFAULT_MAX_GAP_MS,
      requireBargeIn: bargeIn !== undefined,
    };
  } else if (sawThreshold) {
    thresholds = {
      ...(maxFirstAudioMs !== undefined ? { maxFirstAudioMs } : {}),
      ...(maxGapMs !== undefined ? { maxGapMs } : {}),
      ...(requireBargeIn ? { requireBargeIn: true } : {}),
    };
  }

  return {
    help,
    version,
    ...(positional[0] !== undefined ? { url: positional[0] } : {}),
    turns: callerTurns,
    ...(bargeIn !== undefined ? { bargeIn } : {}),
    ...(silence !== undefined ? { silence } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    params,
    ...(dtmf !== undefined ? { dtmf } : {}),
    ...(jitter !== undefined ? { jitter } : {}),
    ...(out !== undefined ? { out } : {}),
    json,
    ci,
    thresholds,
  };
}

function take(argv: string[], index: number, arg: string, flag: string): { value: string; next: number } | null {
  if (arg === flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(`${flag} requires a value`);
    return { value, next: index + 1 };
  }
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: index };
  return null;
}

function numberFlag(flag: string, raw: string, positive = false): number {
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) throw new CliError(`${flag} expects a number`);
  const value = Number(raw);
  if (positive && value <= 0) throw new CliError(`${flag} must be greater than 0`);
  if (value < 0) throw new CliError(`${flag} must be >= 0`);
  return value;
}

function useColor(io: CliIo, json: boolean): boolean {
  if (json) return false;
  if (typeof io.color === 'boolean') return io.color;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return process.stdout.isTTY === true;
}

function helpText(): string {
  return `callsim (npm: voice-callsim) ${packageVersion()} — test a Twilio Media Streams voice bot without placing a call

Usage:
  voice-callsim <ws-url> [options]
  callsim <ws-url> [options]

Options:
  --say <text>              Caller turn. Repeatable, in order. Bundled fixtures:
                            hello, yes, okay, goodbye. Other text is synthesized.
  --audio <file.wav>        Caller turn from a WAV (PCM or μ-law, any rate).
  --barge-in <seconds>      Start each later turn this long after the bot starts
                            speaking. One --say/--audio is repeated as the interrupt.
  --silence <seconds>       Pause after the bot finishes, between turns.
                            Default ${DEFAULT_SILENCE_SEC}. Ignored when barging in.
  --timeout <seconds>       Whole-call limit. Default ${DEFAULT_TIMEOUT_SEC}.
  --param <key=value>       start.customParameters entry. Repeatable.
  --dtmf <digits>           Send 0-9 * # after the last caller turn.
  --jitter <ms>             Random extra delay, up to N ms, on each caller frame.
  --out <call.wav>          Stereo WAV: left caller, right bot audio as played.
  --json                    Print the report as JSON.
  --ci                      Exit 1 when a threshold fails. With no threshold
                            flags, defaults are --max-first-audio-ms ${CI_DEFAULT_MAX_FIRST_AUDIO_MS},
                            --max-gap-ms ${CI_DEFAULT_MAX_GAP_MS}, and --require-barge-in
                            when --barge-in is set.
  --max-first-audio-ms <n>  Fail if any turn's first bot audio is slower.
  --max-gap-ms <n>          Fail if the longest playback underrun is slower.
  --require-barge-in        Fail unless clear arrives and bot audio stops.
  --version
  --help

callsim is not affiliated with Twilio.
`;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 2;
    });
}
