import { describe, expect, it } from 'vitest';
import { linearToMulaw, mulawToLinear, pcm16ToMulaw } from '../src/mulaw.js';

describe('μ-law', () => {
  it('matches G.711 reference points', () => {
    expect(linearToMulaw(0)).toBe(0xff);
    expect(mulawToLinear(0xff)).toBe(0);
    expect(linearToMulaw(32767)).toBe(0x80);
    expect(mulawToLinear(0x80)).toBe(32124);
    expect(linearToMulaw(-32768)).toBe(0x00);
  });

  it('round-trips a tone within the quantizer error', () => {
    const pcm = new Int16Array(160);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.round(Math.sin((2 * Math.PI * i) / 20) * 8000);
    const encoded = pcm16ToMulaw(pcm);
    expect(encoded).toHaveLength(160);
    for (let i = 0; i < pcm.length; i += 1) {
      const back = mulawToLinear(encoded[i]!);
      expect(Math.abs(back - pcm[i]!)).toBeLessThan(400);
    }
  });
});
