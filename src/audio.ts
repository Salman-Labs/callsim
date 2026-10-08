import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_BYTES, SAMPLE_RATE } from './constants.js';
import { pcm16ToMulaw } from './mulaw.js';
import { normalizePhrase, synthesizeSpeech } from './synth.js';
import { decodeWav, wavToMonoPcm8k } from './wav.js';

/** Bundled synthetic utterances. Anything else is synthesized at runtime. */
export const FIXTURE_PHRASES = ['hello', 'yes', 'okay', 'goodbye'] as const;

export function fixturesDirectory(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'fixtures');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('callsim fixtures directory not found');
}

export function audioForText(text: string): Int16Array {
  const slug = normalizePhrase(text).replace(/ /g, '-');
  if ((FIXTURE_PHRASES as readonly string[]).includes(slug)) {
    const path = join(fixturesDirectory(), `${slug}.wav`);
    if (existsSync(path)) return wavToMonoPcm8k(decodeWav(readFileSync(path)));
  }
  return synthesizeSpeech(text);
}

export function tonePcm(ms: number, freq = 440, sampleRate = SAMPLE_RATE): Int16Array {
  const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000);
  }
  return out;
}

/** Split μ-law into 20 ms frames, padding the tail with silence (0xFF). */
export function frameMulaw(mulaw: Uint8Array, frameBytes = FRAME_BYTES): Buffer[] {
  if (mulaw.length === 0) return [];
  const frames: Buffer[] = [];
  for (let offset = 0; offset < mulaw.length; offset += frameBytes) {
    const slice = mulaw.subarray(offset, Math.min(offset + frameBytes, mulaw.length));
    if (slice.length === frameBytes) {
      frames.push(Buffer.from(slice));
      continue;
    }
    const padded = Buffer.alloc(frameBytes, 0xff);
    Buffer.from(slice).copy(padded);
    frames.push(padded);
  }
  return frames;
}

export function pcmToFrames(pcm: Int16Array): Buffer[] {
  return frameMulaw(pcm16ToMulaw(pcm));
}
