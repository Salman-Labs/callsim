import { mulawToLinear } from './mulaw.js';
import { SAMPLE_RATE } from './constants.js';

export interface DecodedWav {
  audioFormat: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Interleaved PCM 16-bit at the file's sample rate. */
  pcm16: Int16Array;
}

export function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === 'fmt ') {
      if (end - start < 16) throw new Error('WAV fmt chunk is truncated');
      audioFormat = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  if (!data || !audioFormat || !channels || !sampleRate) {
    throw new Error('WAV is missing fmt or data');
  }
  const pcm16 = decodeSamples(data, audioFormat, bitsPerSample, channels);
  return { audioFormat, sampleRate, channels, bitsPerSample, pcm16 };
}

function decodeSamples(data: Buffer, format: number, bits: number, channels: number): Int16Array {
  if (format === 1 && bits === 16) {
    const count = Math.floor(data.length / 2);
    const out = new Int16Array(count);
    for (let i = 0; i < count; i += 1) out[i] = data.readInt16LE(i * 2);
    return out;
  }
  if (format === 1 && bits === 8) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = (data[i]! - 128) << 8;
    return out;
  }
  if (format === 7 && bits === 8) {
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = mulawToLinear(data[i]!);
    return out;
  }
  throw new Error(`Unsupported WAV encoding format=${format} bits=${bits} channels=${channels}`);
}

export function downmixMono(pcm: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return pcm;
  const frames = Math.floor(pcm.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm[i * channels + c] ?? 0;
    out[i] = Math.round(sum / channels);
  }
  return out;
}

export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  if (input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const ratio = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    const s0 = input[i0] ?? 0;
    const s1 = input[i1] ?? 0;
    out[i] = Math.round(s0 + (s1 - s0) * frac);
  }
  return out;
}

/** Mono 8 kHz PCM 16-bit, the caller audio callsim sends. */
export function wavToMonoPcm8k(wav: DecodedWav): Int16Array {
  const mono = downmixMono(wav.pcm16, wav.channels);
  return resampleLinear(mono, wav.sampleRate, SAMPLE_RATE);
}

export function encodeWav(interleaved: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataBytes = interleaved.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  const blockAlign = channels * 2;
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < interleaved.length; i += 1) {
    buffer.writeInt16LE(interleaved[i] ?? 0, 44 + i * 2);
  }
  return buffer;
}
