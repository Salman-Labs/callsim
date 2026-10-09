import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { ScenarioUsageError } from './errors.js';
import type { ScenarioTurn, VoiceConfig } from './types.js';
import { applyPhoneBand } from '../voice/phone-band.js';
import { synthesizeSay } from '../voice/tts.js';
import { decodeWav, downmixMono } from '../wav.js';

export interface PreparedClip {
  pcm: Int16Array;
  sampleRate: number;
  text: string;
}

export async function prepareTurnAudio(
  turn: ScenarioTurn,
  scenarioDir: string,
  voice: VoiceConfig | undefined,
  cwd: string,
): Promise<PreparedClip | null> {
  if (turn.say === undefined && turn.audio === undefined) return null;
  let pcm: Int16Array;
  let sampleRate: number;
  let text: string;
  if (turn.audio !== undefined) {
    const path = resolve(scenarioDir, turn.audio);
    let decoded;
    try {
      decoded = decodeWav(readFileSync(path));
    } catch (err) {
      throw new ScenarioUsageError(
        `Cannot read caller audio ${turn.audio}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    pcm = downmixMono(decoded.pcm16, decoded.channels);
    sampleRate = decoded.sampleRate;
    text = basename(turn.audio);
  } else {
    const spoken = await synthesizeSay({
      text: turn.say ?? '',
      ...(voice?.tts ? { provider: voice.tts } : {}),
      ...(voice?.voice ? { voice: voice.voice } : {}),
      ...(voice?.cache ? { cacheDir: voice.cache } : {}),
      cwd,
    });
    pcm = spoken.pcm;
    sampleRate = spoken.sampleRate;
    text = turn.say ?? '';
  }
  if (voice?.phone_band) {
    pcm = applyPhoneBand(pcm, sampleRate);
    sampleRate = 8000;
  }
  return { pcm, sampleRate, text };
}
