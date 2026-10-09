import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startBuggyBot } from '../examples/buggy-bot.js';
import { startGoodBot } from '../examples/good-bot.js';
import { runCli } from '../src/cli.js';
import type { ScenarioReport } from '../src/scenario/types.js';

const hello = join(process.cwd(), 'fixtures', 'hello.wav');

describe('twilio scenario runner', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('passes the good bot on timing, clear, and dtmf', async () => {
    const bot = await startGoodBot();
    const file = writeScenario(bot.url);
    try {
      const result = await capture(['run', file, '--label', 'Hello barge-in', '--json', '--ci']);
      expect(result.stderr).toBe('');
      if (result.code !== 0) throw new Error(result.stdout);
      const report = JSON.parse(result.stdout) as ScenarioReport;
      expect(report.ok).toBe(true);
      expect(report.transport).toBe('twilio');
      expect(report.schema).toBe('callsim.report/1');
      expect(report.twilio?.underruns.count).toBe(0);
      expect(report.twilio?.marks.echoed).toBeGreaterThan(0);
      expect(report.dtmf).toEqual([{ turn: 3, digits: '5' }]);
      expect(report.failures).toEqual([]);
    } finally {
      await bot.close();
    }
  }, 30_000);

  it('fails the buggy bot on first audio, gap, and missing clear', async () => {
    const bot = await startBuggyBot();
    const file = writeScenario(bot.url);
    try {
      const result = await capture(['run', file, '--label', 'Hello barge-in', '--json', '--ci']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as ScenarioReport;
      expect(report.ok).toBe(false);
      const text = report.failures.join('\n');
      expect(text).toMatch(/first audio|playback gap|did not receive clear/);
      expect(text).toMatch(/did not receive clear/);
    } finally {
      await bot.close();
    }
  }, 30_000);

  it('runs the good bot through MCP run_scenario', async () => {
    const bot = await startGoodBot();
    const file = writeScenario(bot.url);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'dist/cli.js'), 'mcp'],
      cwd: process.cwd(),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'callsim-twilio-test', version: '0.0.0' });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'run_scenario',
        arguments: { file, label: 'Hello barge-in', timeoutSec: 20 },
      });
      expect(result.isError).not.toBe(true);
      const body = textOf(result);
      const report = JSON.parse(body) as { ok: boolean; runId: string };
      expect(report.ok).toBe(true);
      expect(report.runId).toMatch(/^[A-Za-z0-9]/);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      await bot.close();
    }
  }, 30_000);

  function writeScenario(url: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'callsim-twilio-'));
    dirs.push(dir);
    const path = join(dir, 'hello.yaml');
    writeFileSync(
      path,
      `name: Twilio media stream
transport: twilio
twilio:
  url: ${JSON.stringify(url)}
  params:
    voice: test
defaults:
  max_first_audio_ms: 500
  max_gap_ms: 80
scenarios:
  - label: Hello barge-in
    turns:
      - audio: ${JSON.stringify(hello)}
      - audio: ${JSON.stringify(hello)}
        barge_in_after_ms: 120
        expect:
          require_clear: true
      - dtmf: "5"
`,
    );
    return path;
  }
});

function textOf(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  const text = result.content.find((item) => item && typeof item === 'object' && 'type' in item && item.type === 'text');
  return text && typeof text === 'object' && 'text' in text && typeof text.text === 'string' ? text.text : '';
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
    color: false,
  });
  return { code, stdout, stderr };
}
