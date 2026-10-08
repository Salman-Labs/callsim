import { SAMPLE_RATE } from './constants.js';
import { encodeWav } from './wav.js';

/** Stereo recording. Channel 0 is the caller, channel 1 is bot audio as played. */
export class StereoRecording {
  private left = new Int16Array(0);
  private right = new Int16Array(0);
  private leftLen = 0;
  private rightLen = 0;

  write(channel: 0 | 1, atMs: number, pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const start = Math.max(0, Math.round((atMs * SAMPLE_RATE) / 1000));
    this.blit(channel, start, pcm, pcm.length);
  }

  /** Drop the unplayed tail of a bot chunk that started at `atMs`. */
  trimBot(atMs: number, totalSamples: number, playedSamples: number): void {
    const start = Math.max(0, Math.round((atMs * SAMPLE_RATE) / 1000));
    const from = Math.max(0, playedSamples);
    for (let i = from; i < totalSamples; i += 1) {
      const idx = start + i;
      if (idx >= 0 && idx < this.rightLen) this.right[idx] = 0;
    }
  }

  toWav(): Buffer {
    const n = Math.max(this.leftLen, this.rightLen);
    const interleaved = new Int16Array(n * 2);
    for (let i = 0; i < n; i += 1) {
      interleaved[i * 2] = i < this.leftLen ? (this.left[i] ?? 0) : 0;
      interleaved[i * 2 + 1] = i < this.rightLen ? (this.right[i] ?? 0) : 0;
    }
    return encodeWav(interleaved, SAMPLE_RATE, 2);
  }

  private blit(channel: 0 | 1, start: number, pcm: Int16Array, count: number): void {
    const end = start + count;
    this.ensure(channel, end);
    const buf = channel === 0 ? this.left : this.right;
    for (let i = 0; i < count; i += 1) buf[start + i] = pcm[i] ?? 0;
    if (channel === 0) this.leftLen = Math.max(this.leftLen, end);
    else this.rightLen = Math.max(this.rightLen, end);
  }

  private ensure(channel: 0 | 1, length: number): void {
    const buf = channel === 0 ? this.left : this.right;
    if (buf.length >= length) return;
    let cap = Math.max(buf.length, 4096);
    while (cap < length) cap *= 2;
    const next = new Int16Array(cap);
    const used = channel === 0 ? this.leftLen : this.rightLen;
    next.set(buf.subarray(0, used));
    if (channel === 0) this.left = next;
    else this.right = next;
  }
}
