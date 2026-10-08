import { describe, expect, it } from 'vitest';
import { evaluateThresholds } from '../src/thresholds.js';
import type { BargeInMetric, TurnMetric, UnderrunMetric } from '../src/types.js';

const turns: TurnMetric[] = [
  { turn: 1, label: 'hello', firstAudioMs: 80 },
  { turn: 2, label: 'hello', firstAudioMs: 90 },
];
const underruns: UnderrunMetric = { count: 0, longestGapMs: 0, gapsMs: [] };
const barge: BargeInMetric[] = [{ turn: 2, clearReceived: true, msToClear: 12, botAudioAfterClearMs: 0 }];

describe('evaluateThresholds', () => {
  it('passes a healthy call', () => {
    expect(
      evaluateThresholds(
        { turns, underruns, bargeIn: barge },
        { maxFirstAudioMs: 400, maxGapMs: 40, requireBargeIn: true },
      ),
    ).toEqual([]);
  });

  it('reports slow audio, underruns, and a missing clear', () => {
    const failures = evaluateThresholds(
      {
        turns: [{ turn: 1, label: 'hello', firstAudioMs: 900 }],
        underruns: { count: 3, longestGapMs: 140, gapsMs: [140, 130, 120] },
        bargeIn: [{ turn: 2, clearReceived: false, msToClear: null, botAudioAfterClearMs: 0 }],
      },
      { maxFirstAudioMs: 400, maxGapMs: 40, requireBargeIn: true },
    );
    expect(failures.join('\n')).toMatch(/900 ms/);
    expect(failures.join('\n')).toMatch(/140 ms/);
    expect(failures.join('\n')).toMatch(/did not receive clear/);
  });
});
