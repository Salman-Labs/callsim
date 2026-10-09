import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatScenarioReports } from './scenario/format.js';
import { junitXml } from './scenario/junit.js';
import { runScenarios, scenarioExitCode } from './scenario/run.js';
import { ScenarioUsageError } from './scenario/errors.js';
import { packageVersion } from './version.js';

interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runScenariosCommand(argv: string[], io: CliIo): Promise<number> {
  try {
    const args = parseRunArgs(argv);
    if (args.help) {
      io.stdout(runHelp());
      return 0;
    }
    const reports = await runScenarios({
      files: args.files,
      ...(args.labels.length > 0 ? { labels: args.labels } : {}),
      ...(Object.keys(args.tags).length > 0 ? { tags: args.tags } : {}),
      judgeRequired: args.judgeRequired,
      ...(args.timeoutSec !== undefined ? { timeoutMs: args.timeoutSec * 1000 } : {}),
    });
    if (args.junit) {
      mkdirSync(dirname(args.junit), { recursive: true });
      writeFileSync(args.junit, junitXml(reports));
    }
    if (args.json) io.stdout(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
    else io.stdout(`${formatScenarioReports(reports)}\n`);
    const code = scenarioExitCode(reports);
    if (code === 2) {
      for (const report of reports) {
        if (report.error?.exitCode === 2) io.stderr(`${report.error.message}\n`);
      }
    }
    return code;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

interface RunArgs {
  help: boolean;
  files: string[];
  labels: string[];
  tags: Record<string, string>;
  json: boolean;
  ci: boolean;
  judgeRequired: boolean;
  junit?: string;
  timeoutSec?: number;
}

function parseRunArgs(argv: string[]): RunArgs {
  const files: string[] = [];
  const labels: string[] = [];
  const tags: Record<string, string> = {};
  let help = false;
  let json = false;
  let ci = false;
  let judgeRequired = false;
  let junit: string | undefined;
  let timeoutSec: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
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
    if (arg === '--judge-required') {
      judgeRequired = true;
      continue;
    }
    const label = take(argv, i, arg, '--label');
    if (label) {
      labels.push(label.value);
      i = label.next;
      continue;
    }
    const tag = take(argv, i, arg, '--tags');
    if (tag) {
      const eq = tag.value.indexOf('=');
      if (eq <= 0) throw new ScenarioUsageError('--tags expects key=value');
      tags[tag.value.slice(0, eq)] = tag.value.slice(eq + 1);
      i = tag.next;
      continue;
    }
    const junitFlag = take(argv, i, arg, '--junit');
    if (junitFlag) {
      junit = junitFlag.value;
      i = junitFlag.next;
      continue;
    }
    const timeout = take(argv, i, arg, '--timeout');
    if (timeout) {
      const value = Number(timeout.value);
      if (!Number.isFinite(value) || value <= 0) throw new ScenarioUsageError('--timeout expects a number of seconds greater than 0');
      timeoutSec = value;
      i = timeout.next;
      continue;
    }
    if (arg.startsWith('--')) throw new ScenarioUsageError(`Unknown option ${arg}.\n\n${runHelp()}`);
    files.push(arg);
  }
  if (!help && files.length === 0) throw new ScenarioUsageError(`Missing scenario file.\n\n${runHelp()}`);
  return { help, files, labels, tags, json, ci, judgeRequired, ...(junit ? { junit } : {}), ...(timeoutSec !== undefined ? { timeoutSec } : {}) };
}

function take(argv: string[], index: number, arg: string, flag: string): { value: string; next: number } | null {
  if (arg === flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new ScenarioUsageError(`${flag} requires a value`);
    return { value, next: index + 1 };
  }
  if (arg.startsWith(`${flag}=`)) return { value: arg.slice(flag.length + 1), next: index };
  return null;
}

function runHelp(): string {
  return `callsim run (npm: voice-callsim) ${packageVersion()} — scripted caller tests for a voice agent

Usage:
  callsim run <files/globs> [options]
  voice-callsim run <files/globs> [options]

Options:
  --label <text>       Run only scenarios with this label. Repeatable.
  --tags <key=value>   Run scenarios that include every tag. Repeatable.
  --json               Print the callsim.report/1 JSON. One scenario prints an
                       object; several print an array.
  --ci                 Exit 1 when a check fails. Failed checks already exit 1;
                       this flag is accepted so CI scripts can say so.
  --junit <out.xml>    Write a JUnit report.
  --judge-required     Fail the run when the optional judge is skipped or not ok.
  --timeout <seconds>  Whole-scenario limit. Default 60.
  --help

The scenario file's transport selects the platform. livekit is implemented.
Twilio Media Streams stays on \`callsim <ws-url>\` until a later release.

LiveKit reads LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET from the
environment and does not print them. Optional packages:
  npm install @livekit/rtc-node livekit-server-sdk

Exit codes: 0 pass, 1 failed check, 2 usage or connection error.

callsim is not affiliated with Twilio or LiveKit.
`;
}
