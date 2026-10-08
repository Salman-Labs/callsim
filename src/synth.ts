import { SAMPLE_RATE } from './constants.js';

/**
 * Tiny formant synthesizer. It is not a speech engine: a vowel-ish buzz
 * timed like phonemes, deterministic, with no native dependencies.
 * `--say` uses it when no bundled fixture matches. Pass `--audio` for a
 * real recording.
 */

interface Phoneme {
  ms: number;
  f1: number;
  f2: number;
  f3: number;
  voiced: boolean;
  amp: number;
}

const PH: Record<string, Phoneme> = {
  silence: { ms: 30, f1: 0, f2: 0, f3: 0, voiced: false, amp: 0 },
  hh: { ms: 50, f1: 500, f2: 1500, f3: 2500, voiced: false, amp: 0.25 },
  eh: { ms: 90, f1: 530, f2: 1840, f3: 2480, voiced: true, amp: 0.95 },
  ae: { ms: 90, f1: 800, f2: 1700, f3: 2500, voiced: true, amp: 0.95 },
  iy: { ms: 80, f1: 300, f2: 2200, f3: 3000, voiced: true, amp: 0.9 },
  ey: { ms: 110, f1: 400, f2: 2000, f3: 2550, voiced: true, amp: 0.95 },
  ow: { ms: 120, f1: 450, f2: 800, f3: 2500, voiced: true, amp: 0.95 },
  uw: { ms: 90, f1: 320, f2: 800, f3: 2200, voiced: true, amp: 0.9 },
  uh: { ms: 70, f1: 500, f2: 1200, f3: 2400, voiced: true, amp: 0.85 },
  ah: { ms: 80, f1: 700, f2: 1200, f3: 2500, voiced: true, amp: 0.95 },
  ay: { ms: 130, f1: 550, f2: 1600, f3: 2500, voiced: true, amp: 0.95 },
  l: { ms: 60, f1: 400, f2: 1200, f3: 2600, voiced: true, amp: 0.45 },
  r: { ms: 60, f1: 450, f2: 1100, f3: 1600, voiced: true, amp: 0.5 },
  m: { ms: 60, f1: 280, f2: 900, f3: 2200, voiced: true, amp: 0.4 },
  n: { ms: 50, f1: 280, f2: 1400, f3: 2500, voiced: true, amp: 0.4 },
  s: { ms: 70, f1: 400, f2: 1800, f3: 3200, voiced: false, amp: 0.35 },
  z: { ms: 60, f1: 400, f2: 1600, f3: 2800, voiced: true, amp: 0.4 },
  k: { ms: 40, f1: 500, f2: 1500, f3: 2500, voiced: false, amp: 0.3 },
  g: { ms: 40, f1: 400, f2: 1400, f3: 2300, voiced: false, amp: 0.3 },
  t: { ms: 35, f1: 500, f2: 1800, f3: 3000, voiced: false, amp: 0.28 },
  d: { ms: 35, f1: 400, f2: 1600, f3: 2700, voiced: false, amp: 0.28 },
  p: { ms: 35, f1: 400, f2: 1000, f3: 2200, voiced: false, amp: 0.25 },
  b: { ms: 40, f1: 350, f2: 900, f3: 2100, voiced: false, amp: 0.28 },
  y: { ms: 50, f1: 300, f2: 2100, f3: 3000, voiced: true, amp: 0.55 },
  w: { ms: 50, f1: 320, f2: 700, f3: 2200, voiced: true, amp: 0.5 },
};

const WORDS: Record<string, string[]> = {
  hello: ['hh', 'eh', 'l', 'ow'],
  hi: ['hh', 'ay'],
  hey: ['hh', 'ey'],
  yes: ['y', 'eh', 's'],
  yeah: ['y', 'ae'],
  no: ['n', 'ow'],
  okay: ['ow', 'k', 'ey'],
  ok: ['ow', 'k'],
  goodbye: ['g', 'uh', 'd', 'b', 'ay'],
  bye: ['b', 'ay'],
  thanks: ['t', 'ae', 'n', 'k', 's'],
  please: ['p', 'l', 'iy', 'z'],
  what: ['w', 'ah', 't'],
  time: ['t', 'ay', 'm'],
  is: ['iy', 'z'],
  it: ['iy', 't'],
  the: ['d', 'uh'],
  a: ['uh'],
  zero: ['z', 'iy', 'r', 'ow'],
  one: ['w', 'ah', 'n'],
  two: ['t', 'uw'],
  three: ['t', 'r', 'iy'],
  four: ['f', 'ow', 'r'],
  five: ['f', 'ay', 'v'],
  six: ['s', 'iy', 'k', 's'],
  seven: ['s', 'eh', 'v', 'eh', 'n'],
  eight: ['ey', 't'],
  nine: ['n', 'ay', 'n'],
};

const LETTERS: Record<string, string[]> = {
  a: ['ey'],
  b: ['b', 'iy'],
  c: ['s', 'iy'],
  d: ['d', 'iy'],
  e: ['iy'],
  f: ['eh', 'f'],
  g: ['g', 'iy'],
  h: ['ey', 'hh'],
  i: ['ay'],
  j: ['g', 'ey'],
  k: ['k', 'ey'],
  l: ['eh', 'l'],
  m: ['eh', 'm'],
  n: ['eh', 'n'],
  o: ['ow'],
  p: ['p', 'iy'],
  q: ['k', 'y', 'uw'],
  r: ['ah', 'r'],
  s: ['eh', 's'],
  t: ['t', 'iy'],
  u: ['y', 'uw'],
  v: ['v', 'iy'],
  w: ['d', 'ah', 'b', 'uh', 'l', 'y', 'uw'],
  x: ['eh', 'k', 's'],
  y: ['w', 'ay'],
  z: ['z', 'iy'],
};

// Extra consonants referenced by the word table.
PH.f = { ms: 50, f1: 400, f2: 1400, f3: 2500, voiced: false, amp: 0.3 };
PH.v = { ms: 50, f1: 300, f2: 1200, f3: 2300, voiced: true, amp: 0.35 };

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function synthesizeSpeech(text: string): Int16Array {
  const phrase = normalizePhrase(text);
  if (!phrase) throw new Error('Cannot synthesize empty text');
  const phonemes = phraseToPhonemes(phrase);
  const rng = makeRng(hash(phrase));
  const samples: number[] = [];
  for (const name of phonemes) {
    const phoneme = PH[name] ?? PH.uh!;
    samples.push(...renderPhoneme(phoneme, rng));
  }
  return normalize(samples);
}

function phraseToPhonemes(phrase: string): string[] {
  const out: string[] = [];
  for (const word of phrase.split(' ')) {
    if (!word) continue;
    if (out.length > 0) out.push('silence');
    const known = WORDS[word];
    if (known) {
      out.push(...known);
      continue;
    }
    for (const ch of word) {
      const letter = LETTERS[ch];
      if (letter) out.push(...letter);
    }
  }
  return out.length > 0 ? out : ['ah'];
}

function renderPhoneme(phoneme: Phoneme, rng: () => number): number[] {
  const n = Math.max(1, Math.round((phoneme.ms * SAMPLE_RATE) / 1000));
  const r1 = resonator(phoneme.f1 || 200, phoneme.voiced ? 90 : 200);
  const r2 = resonator(phoneme.f2 || 1200, phoneme.voiced ? 110 : 250);
  const r3 = resonator(phoneme.f3 || 2500, phoneme.voiced ? 150 : 300);
  const out = new Array<number>(n);
  let phase = 0;
  const f0 = 125;
  for (let i = 0; i < n; i += 1) {
    let src: number;
    if (!phoneme.voiced || phoneme.amp === 0) {
      src = (rng() * 2 - 1) * (phoneme.amp === 0 ? 0 : 0.6);
    } else {
      phase += f0 / SAMPLE_RATE;
      let imp = 0;
      if (phase >= 1) {
        phase -= 1;
        imp = 1;
      }
      src = imp + (rng() * 2 - 1) * 0.02;
    }
    const y = r1(src) * 0.7 + r2(src) * 0.25 + r3(src) * 0.12;
    const env = envelope(i, n);
    out[i] = y * phoneme.amp * env;
  }
  return out;
}

function resonator(freq: number, bandwidth: number): (x: number) => number {
  const r = Math.exp((-Math.PI * bandwidth) / SAMPLE_RATE);
  const a1 = 2 * r * Math.cos((2 * Math.PI * freq) / SAMPLE_RATE);
  const a2 = -(r * r);
  let y1 = 0;
  let y2 = 0;
  return (x: number) => {
    const y = x + a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = y;
    return y;
  };
}

function envelope(i: number, n: number): number {
  const attack = Math.min(40, Math.floor(n / 4));
  if (i < attack) return (i + 1) / (attack + 1);
  if (i > n - attack) return Math.max(0, (n - i) / (attack + 1));
  return 1;
}

function normalize(samples: number[]): Int16Array {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? 12000 / peak : 0;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.round((samples[i] ?? 0) * gain);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
