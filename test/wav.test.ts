import { describe, expect, it } from 'vitest';
import { pcm16ToMulaw } from '../src/mulaw.js';
import { tonePcm } from '../src/audio.js';
import { decodeWav, encodeWav, wavToMonoPcm8k } from '../src/wav.js';

describe('wav', () => {
  it('round-trips stereo PCM', () => {
    const interleaved = new Int16Array([1, -2, 3, -4, 1000, -1000]);
    const wav = encodeWav(interleaved, 8000, 2);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels).toBe(2);
    expect(Array.from(decoded.pcm16)).toEqual(Array.from(interleaved));
  });

  it('decodes μ-law WAV and resamples PCM to 8 kHz mono', () => {
    const pcm = tonePcm(20);
    const mulaw = pcm16ToMulaw(pcm);
    const data = mulaw;
    const header = Buffer.alloc(44 + data.length);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(7, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    data.copy(header, 44);
    const decoded = decodeWav(header);
    expect(decoded.audioFormat).toBe(7);
    expect(decoded.pcm16.length).toBe(pcm.length);

    const high = tonePcm(20, 440, 16000);
    const stereo = new Int16Array(high.length * 2);
    for (let i = 0; i < high.length; i += 1) {
      stereo[i * 2] = high[i]!;
      stereo[i * 2 + 1] = high[i]!;
    }
    const wav = encodeWav(stereo, 16000, 2);
    const mono = wavToMonoPcm8k(decodeWav(wav));
    expect(mono.length).toBeGreaterThan(100);
    expect(mono.length).toBeLessThan(200);
  });
});
