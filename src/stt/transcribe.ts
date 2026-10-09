import { ScenarioUsageError, scrubSecrets } from '../scenario/errors.js';
import type { SttConfig } from '../scenario/types.js';
import { encodeWav, resampleLinear } from '../wav.js';

/**
 * Speech-to-text for transports that do not supply a transcript.
 * Keys are read from the environment and are never written into errors.
 */
export async function transcribePcm(config: SttConfig, pcm: Int16Array, sampleRate: number): Promise<string> {
  if (config.provider === 'openai') return openaiTranscribe(config, pcm, sampleRate);
  if (config.provider === 'deepgram') return deepgramTranscribe(config, pcm, sampleRate);
  return whisperLocal(config, pcm, sampleRate);
}

export function missingWhisperMessage(): string {
  return ['whisper-local needs an optional package that is not installed.', 'Install it with:', '  npm install smart-whisper', 'Set WHISPER_MODEL to a ggml model path, or stt.model in the scenario.'].join('\n');
}

async function openaiTranscribe(config: SttConfig, pcm: Int16Array, sampleRate: number): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ScenarioUsageError('OPENAI_API_KEY is not set. It is required for stt.provider openai.');
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const wav = encodeWav(pcm, sampleRate, 1);
  const body = new FormData();
  body.append('file', new Blob([wav], { type: 'audio/wav' }), 'callsim.wav');
  body.append('model', config.model || 'whisper-1');
  if (config.language) body.append('language', config.language);
  const response = await request(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
  });
  const payload = await readJson(response);
  const text = payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string' ? (payload as { text: string }).text : '';
  return text.trim();
}

async function deepgramTranscribe(config: SttConfig, pcm: Int16Array, sampleRate: number): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new ScenarioUsageError('DEEPGRAM_API_KEY is not set. It is required for stt.provider deepgram.');
  const model = config.model || 'nova-2';
  const wav = encodeWav(pcm, sampleRate, 1);
  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', model);
  url.searchParams.set('smart_format', 'true');
  if (config.language) url.searchParams.set('language', config.language);
  const response = await request(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
    body: wav,
  });
  const payload = await readJson(response);
  const text = deepgramText(payload);
  return text.trim();
}

async function whisperLocal(config: SttConfig, pcm: Int16Array, sampleRate: number): Promise<string> {
  const model = config.model || process.env.WHISPER_MODEL;
  if (!model) throw new ScenarioUsageError('Set stt.model or WHISPER_MODEL to a ggml whisper model file.');
  let imported: { Whisper?: new (path: string, opts?: { gpu?: boolean }) => WhisperLike };
  try {
    imported = (await import('smart-whisper')) as typeof imported;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot find package') || message.includes('ERR_MODULE_NOT_FOUND')) {
      throw new ScenarioUsageError(missingWhisperMessage());
    }
    throw new ScenarioUsageError(missingWhisperMessage());
  }
  if (!imported.Whisper) throw new ScenarioUsageError(missingWhisperMessage());
  const whisper = new imported.Whisper(model, { gpu: false });
  try {
    const audio = float16k(pcm, sampleRate);
    const task = await whisper.transcribe(audio, { language: config.language || 'en' });
    const result = await task.result;
    if (typeof result === 'string') return result.trim();
    if (Array.isArray(result)) {
      return result
        .map((segment) => (segment && typeof segment.text === 'string' ? segment.text : ''))
        .join(' ')
        .trim();
    }
    if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string') return result.text.trim();
    return '';
  } finally {
    await whisper.free?.();
  }
}

interface WhisperLike {
  transcribe(audio: Float32Array, opts?: { language?: string }): Promise<{ result: Promise<unknown> }>;
  free?: () => Promise<void> | void;
}

async function request(url: string | URL, init: RequestInit): Promise<Response> {
  try {
    const response = await fetch(url, init);
    if (!response.ok) {
      const body = scrubSecrets(await response.text()).slice(0, 300);
      throw new ScenarioUsageError(`STT request failed with HTTP ${response.status}: ${body}`);
    }
    return response;
  } catch (err) {
    if (err instanceof ScenarioUsageError) throw err;
    throw new ScenarioUsageError(`STT request failed: ${scrubSecrets(err instanceof Error ? err.message : String(err))}`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ScenarioUsageError('STT response was not JSON');
  }
}

function deepgramText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const channels = (payload as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } }).results?.channels;
  const transcript = channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof transcript === 'string' ? transcript : '';
}

function float16k(pcm: Int16Array, sampleRate: number): Float32Array {
  const pcm16 = resampleLinear(pcm, sampleRate, 16_000);
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) out[i] = (pcm16[i] ?? 0) / 32768;
  return out;
}
