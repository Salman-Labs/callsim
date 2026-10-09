import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startScriptedAgent, type ScriptedAgent } from '../examples/livekit-agent.js';
import { startLiveKitDev, type LiveKitDevServer } from './livekit-server.js';

const skip = process.env.CALLSIM_SKIP_LIVEKIT === '1';

describe.skipIf(skip)('callsim mcp against livekit-server', () => {
  let server: LiveKitDevServer;
  let agent: ScriptedAgent;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    server = await startLiveKitDev();
    process.env.LIVEKIT_URL = server.url;
    process.env.LIVEKIT_API_KEY = server.apiKey;
    process.env.LIVEKIT_API_SECRET = server.apiSecret;
    agent = await startScriptedAgent({ mode: 'good', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), 'dist/cli.js'), 'mcp'],
      cwd: process.cwd(),
      stderr: 'pipe',
      env: childEnv(),
    });
    client = new Client({ name: 'callsim-livekit-test', version: '0.0.0' });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await agent?.stop();
    await server?.stop();
  });

  it('runs the good scenario and rejects a second run while it is in progress', async () => {
    const first = client.callTool({
      name: 'run_scenario',
      arguments: { file: 'examples/scenarios/order.yaml', label: 'Pickup order', timeoutSec: 60 },
    });
    const second = client.callTool({
      name: 'run_scenario',
      arguments: { file: 'examples/scenarios/order.yaml', label: 'Pickup order', timeoutSec: 60 },
    });
    const [left, right] = await Promise.all([first, second]);
    const results = [left, right].map((result) => ({ error: result.isError === true, body: textOf(result) }));
    const busy = results.filter((result) => result.body.includes('already in progress'));
    const finished = results.filter((result) => !result.body.includes('already in progress'));
    expect(busy).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.error).not.toBe(true);
    const report = JSON.parse(finished[0]?.body ?? '{}') as { ok: boolean; runId: string; runs: { ok: boolean }[] };
    expect(report.ok).toBe(true);
    expect(report.runId).toMatch(/^[A-Za-z0-9]/);
    expect(finished[0]?.body).not.toContain(server.apiKey);
    expect(busy[0]?.body).not.toContain(server.apiKey);

    const stored = await client.callTool({ name: 'get_report', arguments: { runId: report.runId, include: ['transcript'] } });
    expect(stored.isError).not.toBe(true);
    const storedText = textOf(stored);
    expect(storedText).toContain('Order confirmed');
    expect(storedText).not.toContain(server.apiKey);

    const listed = await client.callTool({ name: 'list_runs', arguments: { limit: 5 } });
    expect(textOf(listed)).toContain(report.runId);
    expect(textOf(listed)).not.toContain(server.apiKey);
  }, 90_000);
});

function textOf(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) return '';
  const text = result.content.find((item) => item && typeof item === 'object' && 'type' in item && item.type === 'text');
  return text && typeof text === 'object' && 'text' in text && typeof text.text === 'string' ? text.text : '';
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}
