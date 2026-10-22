import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
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
      // Each reply is two sentences with a pause; the whole reply is scored, not the first sentence.
      expect(report.turns[0]?.agent.said).toBe('Thanks for calling. What can I get you?');
      expect(report.turns[2]?.agent.said).toBe('Updated to a margherita. Anything else?');
      expect(report.turns[3]?.agent.said).toBe('Order confirmed. See you soon.');
      // A closing line with no expect gets no default first-audio gate.
      expect(report.turns[4]?.checks).toEqual([]);
      const agentLines = report.transcript.filter((line) => line.role === 'agent').map((line) => line.text);
      expect(agentLines).toEqual([
        'Thanks for calling. What can I get you?',
        'Sure. Anything else?',
        'Updated to a margherita. Anything else?',
        'Order confirmed. See you soon.',
      ]);
      const callerLines = report.transcript.filter((line) => line.role === 'caller');
      expect(callerLines.map((line) => line.text)).toEqual(['hello', 'yes', 'goodbye.wav']);
      expect(callerLines[0]?.heard).toBe('hello');
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

  it('exits the process after a LiveKit run', async () => {
    const good = await startScriptedAgent({ mode: 'good', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    try {
      const passed = await runProcess(['run', 'examples/scenarios/order.yaml', '--label', 'Pickup order', '--json', '--ci'], 45_000);
      expect(passed.timedOut, passed.stderr || passed.stdout).toBe(false);
      expect(passed.code).toBe(0);
      const report = JSON.parse(passed.stdout) as ScenarioReport;
      expect(report.ok).toBe(true);
    } finally {
      await good.stop();
    }
  }, 60_000);

  it('exits nonzero when the LiveKit scenario fails', async () => {
    const buggy = await startScriptedAgent({ mode: 'buggy', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    try {
      const failed = await runProcess(['run', 'examples/scenarios/order.yaml', '--label', 'Pickup order', '--json', '--ci'], 45_000);
      expect(failed.timedOut, failed.stderr || failed.stdout).toBe(false);
      expect(failed.code).toBe(1);
      const report = JSON.parse(failed.stdout) as ScenarioReport;
      expect(report.ok).toBe(false);
    } finally {
      await buggy.stop();
    }
  }, 60_000);

  it('dispatches and joins through a path-prefixed LIVEKIT_URL', async () => {
    const proxy = await startPrefixProxy('/livekit', 7880);
    const good = await startScriptedAgent({ mode: 'good', url: server.url, apiKey: server.apiKey, apiSecret: server.apiSecret });
    const dir = join(process.cwd(), '.callsim', 'bin');
    const file = join(dir, 'prefixed.yaml');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      `name: Prefixed
transport: livekit
livekit:
  url: ${proxy.url}/livekit
  agent_name: callsim-prefixed
scenarios:
  - label: Greets through a proxy
    turns:
      - expect:
          agent_says_all: ["thanks for calling", "what can I get"]
`,
    );
    try {
      const result = await capture(['run', file, '--json']);
      if (result.code !== 0) throw new Error(`prefixed run failed (${result.code})
${result.stdout}
${result.stderr}`);
      expect(proxy.paths.some((path) => path.startsWith('/livekit/twirp/livekit.AgentDispatchService/CreateDispatch'))).toBe(true);
      expect(proxy.paths.some((path) => path.startsWith('/livekit/rtc'))).toBe(true);
      expect(proxy.paths.filter((path) => !path.startsWith('/livekit/'))).toEqual([]);
    } finally {
      await good.stop();
      await proxy.close();
    }
  }, 60_000);

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

/** Forwards `${prefix}/*` (HTTP and WebSocket) to a local port with the prefix removed, and 404s anything else. */
async function startPrefixProxy(prefix: string, port: number): Promise<{ url: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const sockets = new Set<{ destroy(): void }>();
  const strip = (url = ''): string | null => (url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : null);
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    const path = strip(req.url);
    if (!path) {
      res.writeHead(404).end();
      return;
    }
    const upstream = request({ host: '127.0.0.1', port, path, method: req.method, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    paths.push(req.url ?? '');
    const path = strip(req.url);
    if (!path) {
      socket.destroy();
      return;
    }
    const upstream = connect(port, '127.0.0.1', () => {
      let preamble = `${req.method} ${path} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) preamble += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(`${preamble}\r\n`);
      upstream.write(head);
      sockets.add(socket).add(upstream);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port: listening } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${listening}`,
    paths,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function runProcess(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
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
