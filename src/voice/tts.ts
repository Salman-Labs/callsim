import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScenarioUsageError, scrubSecrets } from '../scenario/errors.js';
import { decodeWav, downmixMono } from '../wav.js';

export interface TtsRequest {
  text: string;
  provider?: string;
  voice?: string;
  /** Directory for `.callsim/tts/<sha256>.wav`. Relative paths are from `cwd`. */
  cacheDir?: string;
  cwd?: string;
}

/** sha256(provider, voice, text). The file name is this hex digest. */
export function ttsCacheKey(provider: string, voice: string, text: string): string {
  return createHash('sha256').update(`${provider}\0${voice}\0${text}`).digest('hex');
}

export function ttsCachePath(request: TtsRequest): string {
  const provider = request.provider || 'openai';
  const voice = request.voice || 'alloy';
  const dir = request.cacheDir || '.callsim/tts';
  const root = request.cwd ?? process.cwd();
  return join(root, dir, `${ttsCacheKey(provider, voice, request.text)}.wav`);
}

/**
 * Resolve `say:` text to mono PCM. A cache hit needs no API key.
 * A miss with no `OPENAI_API_KEY` is a usage error (exit 2).
 */
export async function synthesizeSay(request: TtsRequest): Promise<{ pcm: Int16Array; sampleRate: number; path: string }> {
  const provider = request.provider || 'openai';
  const voice = request.voice || 'alloy';
  const path = ttsCachePath({ ...request, provider, voice });
  if (existsSync(path)) {
    const decoded = decodeWav(readFileSync(path));
    return { pcm: downmixMono(decoded.pcm16, decoded.channels), sampleRate: decoded.sampleRate, path };
  }
  if (provider !== 'openai') {
    throw new ScenarioUsageError(
      `TTS provider "${provider}" is not available. The MVP speaks through OpenAI, or a cached WAV at ${path}.`,
    );
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const snippet = request.text.length > 80 ? `${request.text.slice(0, 77)}...` : request.text;
    throw new ScenarioUsageError(
      `No cached speech for this line and OPENAI_API_KEY is not set. Commit ${displayCache(path)} or set OPENAI_API_KEY.\nText: ${snippet}`,
    );
  }
  const wav = await openaiSpeech(request.text, voice, key);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, wav);
  const decoded = decodeWav(wav);
  return { pcm: downmixMono(decoded.pcm16, decoded.channels), sampleRate: decoded.sampleRate, path };
}

function displayCache(path: string): string {
  const marker = '.callsim/tts/';
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index) : path;
}

async function openaiSpeech(text: string, voice: string, key: string): Promise<Buffer> {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice,
        input: text,
        response_format: 'wav',
      }),
    });
  } catch (err) {
    throw new ScenarioUsageError(`OpenAI TTS request failed: ${scrubSecrets(err instanceof Error ? err.message : String(err))}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new ScenarioUsageError(
      `OpenAI TTS returned HTTP ${response.status}: ${scrubSecrets(body).slice(0, 300)}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}
