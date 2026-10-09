import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispose } from '@livekit/rtc-node';
import { startScriptedAgent } from '../examples/livekit-agent.js';
import { runCli } from '../src/cli.js';
import type { ScenarioReport } from '../src/scenario/types.js';
import { startLiveKitDev, type LiveKitDevServer } from './livekit-server.js';

const skip = process.env.CALLSIM_SKIP_LIVEKIT === '1';

describe.skipIf(skip)('livekit dev server', () => {
  let server: LiveKitDevServer;

  beforeAll(async () => {
    server = await startLiveKitDev();
    process.env.LIVEKIT_URL = server.url;
    process.env.LIVEKIT_API_KEY = server.apiKey;
    process.env.LIVEKIT_API_SECRET = server.apiSecret;
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    await dispose().catch(() => undefined);
  });

  it('passes a scripted good agent and fails the barge-in bug', async () => {
    const good = await startScriptedAgent({ mode: 'good', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    try {
      const passed = await capture(['run', 'examples/scenarios/order.yaml', '--label', 'Pickup order', '--json', '--ci', '--junit', 'callsim-junit.xml']);
      expect(passed.stdout).not.toContain('devkey');
      expect(passed.stderr).not.toContain('devkey');
      if (passed.code !== 0) {
        throw new Error(`good agent failed (${passed.code})\n${passed.stdout}\n${passed.stderr}`);
      }
      const report = JSON.parse(passed.stdout) as ScenarioReport;
      expect(report.schema).toBe('callsim.report/1');
      expect(report.ok).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.caller?.kind).toBe('sip');
      expect(report.caller?.requestedKind).toBe('sip');
      expect(report.warnings).toEqual([]);
      expect(report.room?.startsWith('callsim-')).toBe(true);
      expect(report.dtmf).toEqual([{ turn: 4, digits: '1' }]);
      expect(report.bargeIn[0]?.ok).toBe(true);
      expect(report.bargeIn[0]?.yieldMs).toBeLessThanOrEqual(600);
      expect(report.versions.rtcNode).toBe('1.1.0');
      const wav = readFileSync(join(process.cwd(), report.artifacts.wav!));
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      const events = readFileSync(join(process.cwd(), report.artifacts.events!), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type?: string; audioMs?: number; wallMs?: number });
      const playouts = events.filter((event) => event.type === 'playout');
      expect(playouts.length).toBeGreaterThanOrEqual(2);
      for (const playout of playouts) {
        expect(playout.wallMs ?? 0).toBeGreaterThanOrEqual((playout.audioMs ?? 0) * 0.65);
      }
      expect(readFileSync('callsim-junit.xml', 'utf8')).toContain('Pickup order');
    } finally {
      await good.stop();
    }
  }, 90_000);

  it('reports yield and silence when the agent ignores barge-in', async () => {
    const buggy = await startScriptedAgent({ mode: 'buggy', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    try {
      const failed = await capture(['run', 'examples/scenarios/order.yaml', '--label', 'Pickup order', '--json', '--ci']);
      expect(failed.code).toBe(1);
      const report = JSON.parse(failed.stdout) as ScenarioReport;
      expect(report.ok).toBe(false);
      const text = report.failures.join('\n');
      expect(text).toMatch(/barge-in/);
      expect(text).toMatch(/silent after the interruption/);
      expect(report.bargeIn[0]?.ok).toBe(false);
      expect(report.bargeIn[0]?.yieldMs).toBeGreaterThan(600);
    } finally {
      await buggy.stop();
    }
  }, 90_000);

  it('names a missing agent when dispatch is explicit', async () => {
    const dir = join(process.cwd(), '.callsim', 'bin');
    const file = join(dir, 'dispatch.yaml');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `name: Dispatch\ntransport: livekit\nlivekit:\n  url: \${LIVEKIT_URL}\n  agent_name: callsim-missing-agent\n  join_timeout_ms: 2000\nscenarios:\n  - label: Nobody home\n    userdata:\n      restaurant_id: test-pizzeria\n    turns:\n      - expect:\n          agent_says_any: ["hello"]\n`,
    );
    const result = await capture(['run', file, '--json', '--timeout', '15']);
    expect(result.code).toBe(2);
    expect(result.stdout).not.toContain('devkey');
    expect(result.stderr).not.toContain('devkey');
    const report = JSON.parse(result.stdout) as ScenarioReport;
    expect(report.ok).toBe(false);
    expect(report.error?.exitCode).toBe(2);
    expect(`${report.error?.code} ${report.error?.message}`).toMatch(/agent_not_joined|dispatch_failed/);
  }, 30_000);
});

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
