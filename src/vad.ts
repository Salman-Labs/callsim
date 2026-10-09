import type { AgentVadEvent } from './transport.js';

/** Peak absolute sample that counts as speech. Telephony tones sit well above this. */
export const ENERGY_VAD_PEAK = 500;

/**
 * Quiet time required before an utterance is over. `stop.atMs` is the first
 * quiet frame, so the hangover confirms the end without inflating yield time.
 */
export const ENERGY_VAD_HANGOVER_MS = 200;

export class EnergyVad {
  private speaking = false;
  private speechStart = 0;
  private quietSince: number | null = null;

  push(pcm: Int16Array, sampleRate: number, atMs: number, threshold = ENERGY_VAD_PEAK): AgentVadEvent | null {
    if (pcm.length === 0 || sampleRate <= 0) return null;
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const sample = Math.abs(pcm[i] ?? 0);
      if (sample > peak) peak = sample;
    }
    if (peak >= threshold) {
      this.quietSince = null;
      if (!this.speaking) {
        this.speaking = true;
        this.speechStart = atMs;
        return { type: 'start', atMs };
      }
      return null;
    }
    if (!this.speaking) return null;
    if (this.quietSince === null) this.quietSince = atMs;
    if (atMs - this.quietSince >= ENERGY_VAD_HANGOVER_MS) {
      const stopAt = this.quietSince;
      const speechMs = Math.max(0, stopAt - this.speechStart);
      this.speaking = false;
      this.quietSince = null;
      return { type: 'stop', atMs: stopAt, speechMs };
    }
    return null;
  }

  get active(): boolean {
    return this.speaking;
  }
}
