import { exec } from 'node:child_process';
import { ScenarioUsageError, scrubSecrets } from './errors.js';
import type { ScenarioVerify, VerifyResult } from './types.js';

export async function runVerify(verify: ScenarioVerify, cwd: string): Promise<VerifyResult & { failures: string[] }> {
  if ('run' in verify) return runCommand(verify.run, verify.expect_exit ?? 0, cwd);
  return runHttp(verify.http);
}

async function runCommand(command: string, expectExit: number, cwd: string): Promise<VerifyResult & { failures: string[] }> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    exec(command, { cwd, timeout: 15_000, maxBuffer: 256_000 }, (err, stdout, stderr) => {
      const code = typeof err?.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
  const ok = result.code === expectExit;
  const detail = ok
    ? `exit ${result.code}`
    : `exit ${result.code}, expected ${expectExit}${tail(result.stdout, result.stderr)}`;
  return {
    ran: true,
    ok,
    detail,
    failures: ok ? [] : [`verify: command exited ${result.code} (expected ${expectExit})`],
  };
}

async function runHttp(http: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  expect_status?: number;
  expect_json?: Record<string, unknown>;
}): Promise<VerifyResult & { failures: string[] }> {
  const expectStatus = http.expect_status ?? 200;
  let response: Response;
  try {
    response = await fetch(http.url, {
      method: http.method ?? 'GET',
      ...(http.headers ? { headers: http.headers } : {}),
    });
  } catch (err) {
    const message = scrubSecrets(err instanceof Error ? err.message : String(err));
    return { ran: true, ok: false, detail: message, failures: [`verify: HTTP request failed (${message})`] };
  }
  const failures: string[] = [];
  if (response.status !== expectStatus) failures.push(`verify: HTTP ${response.status} (expected ${expectStatus})`);
  if (http.expect_json) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      failures.push('verify: response was not JSON');
      body = undefined;
    }
    if (body !== undefined) {
      for (const [path, expected] of Object.entries(http.expect_json)) {
        const actual = valueAt(body, path);
        if (!sameJson(actual, expected)) {
          failures.push(`verify: ${path} expected ${preview(expected)} got ${preview(actual)}`);
        }
      }
    }
  }
  return {
    ran: true,
    ok: failures.length === 0,
    ...(failures.length > 0 ? { detail: failures.join('; ') } : { detail: `HTTP ${response.status}` }),
    failures,
  };
}

export function valueAt(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sameJson(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function tail(stdout: string, stderr: string): string {
  const text = scrubSecrets(`${stderr}\n${stdout}`).trim();
  if (!text) return '';
  const clipped = text.length > 400 ? text.slice(0, 400) : text;
  return `\n${clipped}`;
}

export function assertVerifyShape(verify: ScenarioVerify): void {
  if ('run' in verify && !verify.run.trim()) throw new ScenarioUsageError('verify.run is empty');
}
