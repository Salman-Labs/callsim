import { describe, expect, it } from 'vitest';
import { audioForText } from '../src/audio.js';
import { synthesizeSpeech } from '../src/synth.js';

describe('speech audio', () => {
  it('synthesizes a deterministic speech-like signal', () => {
    const a = synthesizeSpeech('what time is it');
    const b = synthesizeSpeech('what time is it');
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBeGreaterThan(SAMPLE_FLOOR);
    let energy = 0;
    for (const sample of a) energy += sample * sample;
    expect(Math.sqrt(energy / a.length)).toBeGreaterThan(500);
  });

  it('loads the bundled hello fixture', () => {
    const hello = audioForText('Hello!');
    expect(hello.length).toBeGreaterThan(SAMPLE_FLOOR);
  });
});

const SAMPLE_FLOOR = 8000 * 0.15;
