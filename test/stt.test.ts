import { afterEach, describe, expect, it } from 'vitest';
import { evaluateExpectations } from '../src/scenario/expect.js';
import { missingWhisperMessage, transcribePcm } from '../src/stt/transcribe.js';
import { ScenarioUsageError } from '../src/scenario/errors.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.DEEPGRAM_API_KEY;
});

describe('speech to text fallback', () => {
  it('skips says and heard checks when there is no transcript', () => {
    const result = evaluateExpectations({
      turn: 1,
      expect: { agent_says_any: ['hello'], agent_heard: ['order'] },
      said: '',
      heard: '',
      firstAudioMs: 40,
      barged: false,
      yieldMs: null,
      agentAudioAfterMs: null,
      newAudio: true,
      transcript: 'none',
    });
    expect(result.failures).toEqual([]);
    expect(result.skipped).toEqual(['agent_says_any', 'agent_heard']);
    expect(result.checks.map((check) => check.detail)).toEqual(['skipped (no transcript)', 'skipped (no transcript)']);
  });

  it('transcribes with OpenAI through fetch and does not echo the key', async () => {
    const key = 'sk-openai-test-key-not-real';
    process.env.OPENAI_API_KEY = key;
    let sawAuth = '';
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
      sawAuth = String((init?.headers as { Authorization?: string } | undefined)?.Authorization ?? '');
      return new Response(JSON.stringify({ text: 'two pepperoni' }), { status: 200 });
    }) as typeof fetch;
    const text = await transcribePcm({ provider: 'openai' }, new Int16Array([0, 1000, -1000]), 8000);
    expect(text).toBe('two pepperoni');
    expect(sawAuth).toBe(`Bearer ${key}`);

    globalThis.fetch = (async () => new Response(`bad key ${key}`, { status: 500 })) as typeof fetch;
    await expect(transcribePcm({ provider: 'openai' }, new Int16Array(8), 8000)).rejects.toThrow(ScenarioUsageError);
    try {
      await transcribePcm({ provider: 'openai' }, new Int16Array(8), 8000);
    } catch (err) {
      expect(err instanceof Error ? err.message : '').not.toContain(key);
    }
  });

  it('transcribes with Deepgram through fetch', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test-key-value';
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain('https://api.deepgram.com/v1/listen');
      expect(String((init?.headers as { Authorization?: string } | undefined)?.Authorization)).toBe('Token dg-test-key-value');
      return new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'thanks for calling' }] }] } }),
        { status: 200 },
      );
    }) as typeof fetch;
    const text = await transcribePcm({ provider: 'deepgram', model: 'nova-2' }, new Int16Array(16), 8000);
    expect(text).toBe('thanks for calling');
  });

  it('names the missing key and the missing whisper package', async () => {
    await expect(transcribePcm({ provider: 'openai' }, new Int16Array(4), 8000)).rejects.toThrow(/OPENAI_API_KEY is not set/);
    await expect(transcribePcm({ provider: 'deepgram' }, new Int16Array(4), 8000)).rejects.toThrow(/DEEPGRAM_API_KEY is not set/);
    await expect(transcribePcm({ provider: 'whisper-local', model: 'missing.bin' }, new Int16Array(4), 16000)).rejects.toThrow(
      /smart-whisper/,
    );
    expect(missingWhisperMessage()).toContain('npm install smart-whisper');
  });
});
