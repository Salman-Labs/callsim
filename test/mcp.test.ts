import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { beginRun, endRun } from '../src/mcp/lock.js';
import type { ScenarioReport } from '../src/scenario/types.js';

const secret = 'sk-test-should-not-leak-9f3a';

describe('callsim mcp', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'callsim-mcp-'));
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    writeFileSync(
      join(cwd, 'greeting.yaml'),
      'name: Demo\ntransport: livekit\nscenarios:\n  - label: Greeting\n    tags:\n      feature: greeting\n    turns:\n      - wait_ms: 1\n',
    );
    writeFileSync(
      join(cwd, 'needs-env.yaml'),
      'name: Needs env\ntransport: livekit\nlivekit:\n  url: ${CALLSIM_UNSET_URL_FOR_VALIDATE}\nscenarios:\n  - label: Needs url\n    turns:\n      - wait_ms: 1\n',
    );
    writeFileSync(
      join(cwd, 'has-secret.yaml'),
      'name: Secret\ntransport: livekit\nlivekit:\n  url: ${CALLSIM_VISIBLE_SECRET}\nscenarios:\n  - label: Secret url\n    turns:\n      - wait_ms: 1\n',
    );
    writeReport(cwd, '20260101T000000Z-aaaaaa', { ok: true, scenario: 'Baseline', firstAudioMs: 400, checkOk: true, failure: '' });
    writeReport(cwd, '20260102T000000Z-bbbbbb', {
      ok: false,
      scenario: 'Head',
      firstAudioMs: 900,
      checkOk: false,
      failure: `token ${secret}`,
    });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'dist/cli.js'), 'mcp'],
      cwd,
      stderr: 'pipe',
      env: childEnv({ CALLSIM_VISIBLE_SECRET: secret, LIVEKIT_API_KEY: secret }),
    });
    client = new Client({ name: 'callsim-test', version: '0.0.0' });
    await client.connect(transport);
  }, 20_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('advertises annotated tools', async () => {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual([
      'compare_runs',
      'get_report',
      'list_runs',
      'list_scenarios',
      'run_scenario',
      'validate_scenario',
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== 'run_scenario');
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.openWorldHint).toBe(tool.name === 'run_scenario');
    }
  });

  it('lists and validates scenarios without returning secret values', async () => {
    const listed = await toolJson('list_scenarios', {});
    const files = (listed.scenarios as { file: string; scenarios: { label: string; tags: Record<string, string> }[] }[]).map(
      (entry) => entry.file,
    );
    expect(files).toContain('greeting.yaml');
    expect(JSON.stringify(listed)).not.toContain(secret);

    const valid = await toolJson('validate_scenario', { file: 'greeting.yaml' });
    expect(valid.ok).toBe(true);
    expect(valid.missingEnv).toEqual([]);

    const missing = await toolJson('validate_scenario', { file: 'needs-env.yaml' });
    expect(missing.ok).toBe(false);
    expect(missing.missingEnv).toEqual(['CALLSIM_UNSET_URL_FOR_VALIDATE']);
    expect(JSON.stringify(missing)).not.toMatch(/sk-|secret-value|LIVEKIT_API_SECRET=/);

    const hidden = await toolJson('validate_scenario', { file: 'has-secret.yaml' });
    expect(hidden.ok).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain(secret);
  });

  it('reads, lists, and compares stored runs without the planted secret', async () => {
    const report = await toolJson('get_report', { runId: '20260102T000000Z-bbbbbb', include: ['turns'] });
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain('[redacted]');
    expect(report.turns).toBeTruthy();

    const runs = await toolJson('list_runs', { limit: 1 });
    expect((runs.runs as { runId: string }[])).toHaveLength(1);
    expect(JSON.stringify(runs)).not.toContain(secret);

    const compared = await toolJson('compare_runs', { base: '20260101T000000Z-aaaaaa', head: '20260102T000000Z-bbbbbb' });
    expect(compared.latency).toMatchObject({ firstAudioMs: { p50: { base: 400, head: 900, delta: 500 } } });
    expect(compared.checks).toEqual([{ turn: 1, type: 'agent_says_any', base: true, head: false }]);
    expect(JSON.stringify(compared)).not.toContain(secret);
  });

  it('rejects a run id that escapes the runs directory', async () => {
    const result = await client.callTool({ name: 'get_report', arguments: { runId: '../package' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(secret);
  });

  it('validates from the CLI by naming a missing variable', async () => {
    const result = await capture(['validate', join(cwd, 'needs-env.yaml')]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('CALLSIM_UNSET_URL_FOR_VALIDATE');
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  });

  it('keeps a second in-process run from starting', () => {
    expect(beginRun()).toBe(true);
    expect(beginRun()).toBe(false);
    endRun();
    expect(beginRun()).toBe(true);
    endRun();
  });

  async function toolJson(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return JSON.parse(textOf(result)) as Record<string, any>;
  }
});

function textOf(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  const text = result.content.find((item) => item && typeof item === 'object' && 'type' in item && item.type === 'text');
  return text && typeof text === 'object' && 'text' in text && typeof text.text === 'string' ? text.text : '';
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...extra };
}

function writeReport(
  cwd: string,
  runId: string,
  fields: { ok: boolean; scenario: string; firstAudioMs: number; checkOk: boolean; failure: string },
): void {
  const dir = join(cwd, '.callsim', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const report: ScenarioReport = {
    schema: 'callsim.report/1',
    runId,
    scenario: fields.scenario,
    file: 'greeting.yaml',
    transport: 'livekit',
    ok: fields.ok,
    failures: fields.failure ? [fields.failure] : [],
    warnings: [],
    turns: [
      {
        i: 1,
        agent: { said: 'hello', heard: '', firstAudioMs: fields.firstAudioMs, speechMs: 100, interrupted: false },
        checks: [{ type: 'agent_says_any', ok: fields.checkOk }],
      },
    ],
    bargeIn: [],
    dtmf: [],
    latency: { firstAudioMs: { p50: fields.firstAudioMs, p95: fields.firstAudioMs, max: fields.firstAudioMs } },
    transcript: [],
    artifacts: {},
    versions: { callsim: '0.2.0-dev.1' },
  };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
}

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}
