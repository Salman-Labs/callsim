import { pcm16ToMulaw, mulawToPcm16 } from '../mulaw.js';
import { resampleLinear } from '../wav.js';

/**
 * Run mono PCM through the telephony path callsim already uses for Twilio:
 * resample to 8 kHz, μ-law, then back to linear PCM. The result is 8 kHz.
 */
export function applyPhoneBand(pcm: Int16Array, sampleRate: number): Int16Array {
  const pcm8 = resampleLinear(pcm, sampleRate, 8000);
  return mulawToPcm16(pcm16ToMulaw(pcm8));
}
