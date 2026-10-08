/**
 * ITU-T G.711 μ-law.
 * Silence (linear 0) encodes to 0xFF. Full-scale positive encodes to 0x80.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.round(sample);
  if (s > 32767) s = 32767;
  if (s < -32768) s = -32768;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = s === -32768 ? 32767 : -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1) {
    // Walk the exponent until the segment bit is set.
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function mulawToLinear(mulaw: number): number {
  const u = (~mulaw) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

export function pcm16ToMulaw(pcm: Int16Array | ArrayLike<number>): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = linearToMulaw(pcm[i] ?? 0);
  return out;
}

export function mulawToPcm16(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i += 1) out[i] = mulawToLinear(mulaw[i] ?? 0xff);
  return out;
}
