import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_PHRASES } from '../src/audio.js';
import { synthesizeSpeech } from '../src/synth.js';
import { encodeWav } from '../src/wav.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'fixtures');
mkdirSync(dir, { recursive: true });

for (const phrase of FIXTURE_PHRASES) {
  const pcm = synthesizeSpeech(phrase);
  const wav = encodeWav(pcm, 8000, 1);
  const path = join(dir, `${phrase}.wav`);
  writeFileSync(path, wav);
  console.log(`${phrase}.wav  ${(pcm.length / 8000).toFixed(3)} s  ${wav.length} bytes`);
}
