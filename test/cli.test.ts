import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseArgs, runCli } from '../src/cli.js';
import { startBuggyBot } from '../examples/buggy-bot.js';
import { startGoodBot } from '../examples/good-bot.js';

const execFileAsync = promisify(execFile);

describe('cli', () => {
  it('parses ordered turns, params, and ci defaults', () => {
    const args = parseArgs([
      '--say',
      'hello',
      '--audio',
      'clip.wav',
      '--param',
      'voice=marin',
      '--barge-in',
      '0.2',
      'ws://127.0.0.1:9',
    ]);
    expect(args.turns.map((turn) => (turn.text ? turn.text : turn.label))).toEqual(['hello', 'clip.wav']);
    expect(args.params).toEqual({ voice: 'marin' });
    expect(args.bargeIn).toBe(0.2);

    const ci = parseArgs(['--ci', '--barge-in=0.1', '--say=yes', 'ws://localhost/stream']);
    expect(ci.thresholds).toEqual({ maxFirstAudioMs: 1500, maxGapMs: 100, requireBargeIn: true });
    expect(ci.turns).toHaveLength(2);
  });

  it('prints help and rejects a missing URL', async () => {
    const help = await capture(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('--barge-in');
    expect(help.stdout).toContain('voice-callsim <ws-url>');
    expect(help.stdout).toContain('not affiliated with Twilio');

    const missing = await capture([]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/WebSocket URL/);
  });

  it('exits 0 against the good bot and 1 against the buggy bot', async () => {
    const good = await startGoodBot();
    const buggy = await startBuggyBot();
    try {
      const passed = await capture([
        good.url,
        '--say',
        'hello',
        '--barge-in',
        '0.15',
        '--ci',
        '--max-first-audio-ms',
        '500',
        '--max-gap-ms',
        '40',
        '--require-barge-in',
        '--timeout',
        '12',
      ]);
      expect(passed.stderr).toBe('');
      expect(passed.stdout).toContain('PASS');
      expect(passed.code).toBe(0);

      const failed = await capture([
        buggy.url,
        '--say',
        'hello',
        '--barge-in',
        '0.15',
        '--ci',
        '--max-first-audio-ms',
        '400',
        '--max-gap-ms',
        '40',
        '--require-barge-in',
        '--timeout',
        '15',
        '--json',
      ]);
      expect(failed.code).toBe(1);
      const json = JSON.parse(failed.stdout) as { ok: boolean; failures: string[]; underruns: { count: number } };
      expect(json.ok).toBe(false);
      expect(json.underruns.count).toBeGreaterThan(0);
      expect(json.failures.join('\n')).toMatch(/clear/);
    } finally {
      await good.close();
      await buggy.close();
    }
  }, 30_000);

  it('runs the built bin', async () => {
    const { stdout } = await execFileAsync('node', ['dist/cli.js', '--version'], { cwd: process.cwd() });
    expect(stdout).toContain('voice-callsim 0.2.0-dev.1');
  });
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
