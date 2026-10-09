import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { kindName, resolveCallerKind } from '../src/livekit/kind.js';
import { missingLiveKitMessage } from '../src/livekit/load.js';
import { evaluateExpectations } from '../src/scenario/expect.js';
import { junitXml } from '../src/scenario/junit.js';
import { loadScenarioFile } from '../src/scenario/load.js';
import { runScenarios, scenarioExitCode } from '../src/scenario/run.js';
import type { ScenarioReport } from '../src/scenario/types.js';
import type { Transport, TransportConnectOptions } from '../src/transport.js';
import { applyPhoneBand } from '../src/voice/phone-band.js';
import { synthesizeSay, ttsCacheKey } from '../src/voice/tts.js';
import { encodeWav, resampleLinear } from '../src/wav.js';
import { valueAt } from '../src/scenario/verify.js';

describe('scenario runner', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('loads the LiveKit order scenario and names a missing env var', () => {
    const previous = process.env.LIVEKIT_URL;
    process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880';
    try {
      const file = loadScenarioFile(join(process.cwd(), 'examples/scenarios/order.yaml'));
      expect(file.transport).toBe('livekit');
      expect(file.livekit?.caller?.kind).toBe('sip');
      expect(file.livekit?.caller?.attributes?.['sip.phoneNumber']).toBe('+15550001111');
      expect(file.scenarios[0]?.label).toBe('Pickup order');
      expect(file.scenarios[0]?.turns.some((turn) => turn.barge_in_after_ms === 350)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LIVEKIT_URL;
      else process.env.LIVEKIT_URL = previous;
    }

    expect(() => loadScenarioFile(writeYaml('name: x\ntransport: livekit\nlivekit:\n  url: ${CALLSIM_MISSING_VAR_FOR_TEST}\nscenarios:\n  - label: A\n    turns:\n      - wait_ms: 1\n'))).toThrow(/CALLSIM_MISSING_VAR_FOR_TEST/);
  });

  it('fails a say line that is not cached and has no OpenAI key', async () => {
    const key = process.env.OPENAI_API_KEY;
    const base = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const dir = scratch();
    const file = join(dir, 'say.yaml');
    writeAt(file, 'name: Speech\ntransport: livekit\nlivekit:\n  url: ws://127.0.0.1:9\nscenarios:\n  - label: Uncached\n    turns:\n      - say: "this line is not in the cache"\n');
    try {
      const reports = await runScenarios({ files: [file], cwd: dir, outDir: join(dir, 'runs') });
      expect(scenarioExitCode(reports)).toBe(2);
      expect(reports[0]?.error?.message).toMatch(/OPENAI_API_KEY/);
      expect(reports[0]?.error?.message).not.toMatch(/sk-/);
    } finally {
      restore('OPENAI_API_KEY', key);
      restore('OPENAI_BASE_URL', base);
    }
  });

  it('reads a content-addressed TTS cache without a key', async () => {
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const dir = scratch();
    const text = 'cached hello';
    const digest = ttsCacheKey('openai', 'alloy', text);
    const cache = join(dir, '.callsim', 'tts');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, `${digest}.wav`), encodeWav(new Int16Array([0, 1000, -1000, 0]), 8000, 1));
    try {
      const spoken = await synthesizeSay({ text, cacheDir: '.callsim/tts', cwd: dir });
      expect(spoken.sampleRate).toBe(8000);
      expect(spoken.pcm.length).toBe(4);
    } finally {
      restore('OPENAI_API_KEY', key);
    }
  });

  it('formats barge-in and silence failures', () => {
    const result = evaluateExpectations({
      turn: 3,
      expect: { max_yield_ms: 400, agent_says_any: ['updated'], max_agent_audio_after_barge_ms: 400 },
      said: '',
      heard: '',
      firstAudioMs: null,
      barged: true,
      yieldMs: 1240,
      agentAudioAfterMs: 1240,
      newAudio: false,
    });
    expect(result.failures.join('\n')).toMatch(/agent kept speaking 1240 ms after barge-in \(max 400\)/);
    expect(result.failures.join('\n')).toMatch(/silent after the interruption/);
  });

  it('runs phone-band audio through μ-law', () => {
    const pcm = new Int16Array(160);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin(i / 4) * 12000);
    const band = applyPhoneBand(pcm, 16000);
    const linear = resampleLinear(pcm, 16000, 8000);
    expect(band.length).toBe(linear.length);
    expect(Buffer.from(band.buffer).equals(Buffer.from(linear.buffer, linear.byteOffset, linear.byteLength))).toBe(false);
  });

  it('falls back from a rejected SIP kind and keeps a downgraded session', async () => {
    const kinds: string[] = [];
    const rejected = await resolveCallerKind('sip', async (kind) => {
      kinds.push(kind);
      if (kind === 'sip') throw new Error('kind sip is not allowed');
      return { observedKind: 'standard' };
    });
    expect(kinds).toEqual(['sip', 'standard']);
    expect(rejected.kind).toBe('standard');
    expect(rejected.warning).toMatch(/rejected participant kind sip/);
    expect(rejected.warning).toMatch(/same sip\.\* attributes/);

    const downgraded = await resolveCallerKind('sip', async () => ({ observedKind: kindName(0) }));
    expect(downgraded.kind).toBe('standard');
    expect(downgraded.warning).toMatch(/joined as standard/);
  });

  it('writes a report and a non-gating skipped judge', async () => {
    const key = process.env.OPENAI_API_KEY;
    const base = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const dir = scratch();
    const file = join(dir, 'greet.yaml');
    writeAt(file, 'name: Fake\ntransport: fake\nscenarios:\n  - label: Greets\n    judge: Be polite\n    turns:\n      - expect:\n          agent_says_any: ["thanks for calling"]\n');
    try {
      const reports = await runScenarios({
        files: [file],
        cwd: dir,
        outDir: join(dir, 'runs'),
        transportFactory: () => greetingTransport(),
      });
      expect(reports[0]?.schema).toBe('callsim.report/1');
      expect(reports[0]?.ok).toBe(true);
      expect(reports[0]?.judge?.skipped).toBe(true);
      expect(reports[0]?.artifacts.wav).toBeTruthy();
      const saved = JSON.parse(readFileSync(join(dir, 'runs', reports[0]!.runId, 'report.json'), 'utf8')) as ScenarioReport;
      expect(saved.scenario).toBe('Greets');

      const gated = await runScenarios({
        files: [file],
        cwd: dir,
        outDir: join(dir, 'runs'),
        judgeRequired: true,
        transportFactory: () => greetingTransport(),
      });
      expect(gated[0]?.ok).toBe(false);
      expect(gated[0]?.failures.join('\n')).toMatch(/judge:/);
      expect(junitXml(gated)).toContain('<failure');
    } finally {
      restore('OPENAI_API_KEY', key);
      restore('OPENAI_BASE_URL', base);
    }
  });

  it('checks verify over HTTP with a path-equals map', async () => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-token');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ order: { status: 'placed', items: ['pepperoni'] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const dir = scratch();
    const file = join(dir, 'verify.yaml');
    writeAt(
      file,
      `name: Verify\ntransport: fake\nscenarios:\n  - label: Order landed\n    turns:\n      - wait_ms: 1\n    verify:\n      http:\n        url: http://127.0.0.1:${port}/order\n        headers:\n          authorization: Bearer test-token\n        expect_status: 200\n        expect_json:\n          order.status: placed\n          order.items.0: pepperoni\n`,
    );
    try {
      const reports = await runScenarios({
        files: [file],
        cwd: dir,
        outDir: join(dir, 'runs'),
        transportFactory: () => quietTransport(),
      });
      expect(reports[0]?.verify?.ok).toBe(true);
      expect(reports[0]?.ok).toBe(true);
      expect(valueAt({ order: { items: ['pepperoni'] } }, 'order.items.0')).toBe('pepperoni');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('checks verify.run against the process exit code', async () => {
    const dir = scratch();
    const file = join(dir, 'shell.yaml');
    writeAt(
      file,
      'name: Shell\ntransport: fake\nscenarios:\n  - label: Exits zero\n    turns:\n      - wait_ms: 1\n    verify:\n      run: "node -e \\"process.exit(0)\\""\n      expect_exit: 0\n',
    );
    const reports = await runScenarios({
      files: [file],
      cwd: dir,
      outDir: join(dir, 'runs'),
      transportFactory: () => quietTransport(),
    });
    expect(reports[0]?.verify?.ok).toBe(true);
    expect(reports[0]?.ok).toBe(true);
  });

  it('rejects a run with no files and prints runner help', async () => {
    const missing = await capture(['run']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/scenario file/i);

    const help = await capture(['run', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--junit');
    expect(help.stdout).toContain('not affiliated with Twilio or LiveKit');
    expect(missingLiveKitMessage()).toContain('npm install @livekit/rtc-node livekit-server-sdk');
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'callsim-'));
    dirs.push(dir);
    return dir;
  }

  function writeYaml(text: string): string {
    const dir = scratch();
    const path = join(dir, 'scenario.yaml');
    writeAt(path, text);
    return path;
  }
});

function writeAt(path: string, text: string): void {
  writeFileSync(path, text);
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function greetingTransport(): Transport {
  return scriptedTransport(() => {
    /* greeting is scheduled from waitForAgent */
  });
}

function quietTransport(): Transport {
  return scriptedTransport(() => undefined);
}

function scriptedTransport(onReady: (transport: ManualTransport) => void): Transport {
  const manual = new ManualTransport();
  const original = manual.waitForAgent.bind(manual);
  manual.waitForAgent = async (timeoutMs: number) => {
    const presence = await original(timeoutMs);
    setTimeout(() => {
      manual.emitSaid('Thanks for calling. What can I get you?');
      manual.emitVad('start');
      setTimeout(() => manual.emitVad('stop'), 40);
    }, 15);
    onReady(manual);
    return presence;
  };
  return manual;
}

class ManualTransport implements Transport {
  readonly name = 'fake';
  private origin = 0;
  private vadListeners = new Set<(event: { type: 'start' | 'stop'; atMs: number; speechMs?: number }) => void>();
  private saidListeners = new Set<(event: { text: string; final: boolean; atMs: number }) => void>();
  private heardListeners = new Set<(event: { text: string; final: boolean; atMs: number }) => void>();
  private audioListeners = new Set<(frame: { pcm: Int16Array; sampleRate: number; atMs: number }) => void>();

  async connect(_options: TransportConnectOptions): Promise<void> {
    this.origin = performance.now();
  }

  async waitForAgent(_timeoutMs: number): Promise<{ identity: string; joinedMs: number }> {
    return { identity: 'agent-test', joinedMs: this.now() };
  }

  async playCallerAudio(audio: { pcm: Int16Array; sampleRate: number }): Promise<{ audioMs: number; startedAtMs: number; endedAtMs: number }> {
    const startedAtMs = this.now();
    const audioMs = (audio.pcm.length / audio.sampleRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, audioMs)));
    return { audioMs, startedAtMs, endedAtMs: this.now() };
  }

  async sendDtmf(): Promise<void> {}

  onAgentAudio(listener: (frame: { pcm: Int16Array; sampleRate: number; atMs: number }) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onAgentVad(listener: (event: { type: 'start' | 'stop'; atMs: number; speechMs?: number }) => void): () => void {
    this.vadListeners.add(listener);
    return () => this.vadListeners.delete(listener);
  }

  onAgentTranscript(listener: (event: { text: string; final: boolean; atMs: number }) => void): () => void {
    this.saidListeners.add(listener);
    return () => this.saidListeners.delete(listener);
  }

  onCallerHeard(listener: (event: { text: string; final: boolean; atMs: number }) => void): () => void {
    this.heardListeners.add(listener);
    return () => this.heardListeners.delete(listener);
  }

  agentState(): string | null {
    return 'listening';
  }

  now(): number {
    return this.origin ? Math.round(performance.now() - this.origin) : 0;
  }

  roomId(): string | undefined {
    return 'fake-room';
  }

  warnings(): readonly string[] {
    return [];
  }

  hasNativeTranscript(): boolean {
    return true;
  }

  snapshot(): { twilio?: undefined } {
    return {};
  }

  async hangup(): Promise<void> {}

  emitSaid(text: string): void {
    for (const listener of this.saidListeners) listener({ text, final: true, atMs: this.now() });
  }

  emitVad(type: 'start' | 'stop'): void {
    for (const listener of this.vadListeners) listener({ type, atMs: this.now(), ...(type === 'stop' ? { speechMs: 40 } : {}) });
  }
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
