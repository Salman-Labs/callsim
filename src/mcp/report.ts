import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { scrubSecrets } from '../scenario/errors.js';
import { expandInputs, loadScenarioDocument } from '../scenario/load.js';
import type { ScenarioReport } from '../scenario/types.js';
import { validateScenarioFile, type ScenarioValidation } from '../scenario/validate.js';

export interface ScenarioCatalogEntry {
  file: string;
  name?: string;
  transport: string;
  scenarios: { label: string; tags: Record<string, string> }[];
}

const SECRET_ENV = ['LIVEKIT_API_SECRET', 'LIVEKIT_API_KEY', 'OPENAI_API_KEY'] as const;

export function listScenarioCatalog(glob: string | undefined, cwd: string): { scenarios: ScenarioCatalogEntry[]; errors: string[] } {
  const patterns = glob ? [glob] : ['**/*.yaml', '**/*.yml'];
  const explicit = glob !== undefined;
  const scenarios: ScenarioCatalogEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    let paths: string[];
    try {
      paths = expandInputs([pattern], cwd);
    } catch (err) {
      if (explicit) errors.push(scrubSecrets(err instanceof Error ? err.message : String(err)));
      continue;
    }
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const entry = catalogEntry(path, cwd, explicit);
      if (entry.scenario) scenarios.push(entry.scenario);
      if (entry.error) errors.push(entry.error);
    }
  }
  scenarios.sort((a, b) => a.file.localeCompare(b.file));
  return { scenarios, errors };
}

function catalogEntry(path: string, cwd: string, explicit: boolean): { scenario?: ScenarioCatalogEntry; error?: string } {
  const display = relative(cwd, path).split('\\').join('/') || path;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return explicit ? { error: scrubSecrets(`${display}: ${err instanceof Error ? err.message : String(err)}`) } : {};
  }
  if (!isScenarioShape(parsed)) return explicit ? { error: `${display} is not a callsim scenario file` } : {};
  try {
    const loaded = loadScenarioDocument(replaceForCatalog(parsed), path);
    return {
      scenario: {
        file: display,
        ...(loaded.name ? { name: loaded.name } : {}),
        transport: loaded.transport,
        scenarios: loaded.scenarios.map((scenario) => ({ label: scenario.label, tags: scenario.tags ?? {} })),
      },
    };
  } catch (err) {
    return { error: scrubSecrets(`${display}: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

function isScenarioShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'transport' in value && 'scenarios' in value);
}

function replaceForCatalog(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, 'x')) as Record<string, unknown>;
}

export function validateForAgent(file: string, cwd: string): ScenarioValidation {
  return validateScenarioFile(file, cwd);
}

export interface CompactRun {
  runId: string;
  ok: boolean;
  scenario: string;
  file: string;
  transport: string;
  room?: string;
  failures: string[];
  warnings: string[];
  latency?: ScenarioReport['latency'];
  agent?: ScenarioReport['agent'];
  error?: { code: string; message: string; exitCode: 1 | 2 };
}

export function compactReport(report: ScenarioReport): CompactRun {
  return {
    runId: report.runId,
    ok: report.ok,
    scenario: report.scenario,
    file: report.file,
    transport: report.transport,
    ...(report.room ? { room: report.room } : {}),
    failures: report.failures.map((failure) => scrubSecrets(failure)),
    warnings: report.warnings.map((warning) => scrubSecrets(warning)),
    ...(report.latency ? { latency: report.latency } : {}),
    ...(report.agent ? { agent: { identity: report.agent.identity, joinedMs: report.agent.joinedMs } } : {}),
    ...(report.error
      ? { error: { code: report.error.code, message: scrubSecrets(report.error.message), exitCode: report.error.exitCode } }
      : {}),
  };
}

export function runsDirectory(cwd: string): string {
  return join(cwd, '.callsim', 'runs');
}

export function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(runId)) {
    throw new Error('runId is not a callsim run id');
  }
}

export function readRunReport(runId: string, cwd: string): ScenarioReport {
  assertRunId(runId);
  const path = join(runsDirectory(cwd), runId, 'report.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScenarioReport;
  } catch {
    throw new Error(`No callsim report for run ${runId}`);
  }
}

export function readRunEvents(runId: string, cwd: string): unknown[] {
  assertRunId(runId);
  const path = join(runsDirectory(cwd), runId, 'events.jsonl');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const kept = lines.length > 400 ? lines.slice(-400) : lines;
  const events: unknown[] = [];
  for (const line of kept) {
    try {
      events.push(JSON.parse(line) as unknown);
    } catch {
      events.push({ type: 'unparsed' });
    }
  }
  return events;
}

export function listStoredRuns(limit: number, cwd: string): CompactRun[] {
  const root = runsDirectory(cwd);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const runs: { name: string; mtime: number; report: ScenarioReport }[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as ScenarioReport;
      runs.push({ name, mtime: statSync(dir).mtimeMs, report });
    } catch {
      continue;
    }
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  return runs.slice(0, limit).map((run) => compactReport(run.report));
}

export interface RunComparison {
  base: { runId: string; ok: boolean; scenario: string };
  head: { runId: string; ok: boolean; scenario: string };
  latency: {
    firstAudioMs: {
      p50: LatencyDelta;
      p95: LatencyDelta;
      max: LatencyDelta;
    };
  };
  checks: { turn: number; type: string; base: boolean | null; head: boolean | null }[];
}

interface LatencyDelta {
  base: number | null;
  head: number | null;
  delta: number | null;
}

export function compareReports(base: ScenarioReport, head: ScenarioReport): RunComparison {
  const baseChecks = checkMap(base);
  const headChecks = checkMap(head);
  const keys = new Set([...baseChecks.keys(), ...headChecks.keys()]);
  const checks: RunComparison['checks'] = [];
  for (const key of keys) {
    const left = baseChecks.get(key);
    const right = headChecks.get(key);
    const baseOk = left?.ok ?? null;
    const headOk = right?.ok ?? null;
    if (baseOk === headOk) continue;
    const [turn, type] = key.split(':');
    checks.push({ turn: Number(turn), type: type ?? key, base: baseOk, head: headOk });
  }
  checks.sort((a, b) => a.turn - b.turn || a.type.localeCompare(b.type));
  return {
    base: { runId: base.runId, ok: base.ok, scenario: base.scenario },
    head: { runId: head.runId, ok: head.ok, scenario: head.scenario },
    latency: {
      firstAudioMs: {
        p50: latencyDelta(base, head, 'p50'),
        p95: latencyDelta(base, head, 'p95'),
        max: latencyDelta(base, head, 'max'),
      },
    },
    checks,
  };
}

function checkMap(report: ScenarioReport): Map<string, { ok: boolean }> {
  const map = new Map<string, { ok: boolean }>();
  for (const turn of report.turns) {
    for (const check of turn.checks) map.set(`${turn.i}:${check.type}`, { ok: check.ok });
  }
  return map;
}

function latencyDelta(base: ScenarioReport, head: ScenarioReport, key: 'p50' | 'p95' | 'max'): LatencyDelta {
  const left = base.latency?.firstAudioMs[key] ?? null;
  const right = head.latency?.firstAudioMs[key] ?? null;
  return { base: left, head: right, delta: left === null || right === null ? null : right - left };
}

export function redactSecrets(text: string): string {
  let out = scrubSecrets(text);
  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join('[redacted]');
  }
  return out;
}

export function agentJson(value: unknown, isError = false): { content: [{ type: 'text'; text: string }]; isError?: boolean } {
  const text = redactSecrets(JSON.stringify(value, null, 2));
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
