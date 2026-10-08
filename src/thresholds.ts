import { BARGE_AUDIO_GRACE_MS } from './constants.js';
import type { BargeInMetric, CallReport, Thresholds, TurnMetric, UnderrunMetric } from './types.js';

export { BARGE_AUDIO_GRACE_MS };

export function evaluateThresholds(
  report: { turns: TurnMetric[]; underruns: UnderrunMetric; bargeIn: BargeInMetric[] },
  thresholds: Thresholds,
): string[] {
  const failures: string[] = [];
  if (thresholds.maxFirstAudioMs !== undefined) {
    if (report.turns.length === 0) failures.push('no caller turns ran');
    for (const turn of report.turns) {
      if (turn.firstAudioMs === null) {
        failures.push(`turn ${turn.turn} (${turn.label}) produced no bot audio`);
      } else if (turn.firstAudioMs > thresholds.maxFirstAudioMs) {
        failures.push(
          `turn ${turn.turn} (${turn.label}) first audio ${turn.firstAudioMs} ms exceeds ${thresholds.maxFirstAudioMs} ms`,
        );
      }
    }
  }
  if (thresholds.maxGapMs !== undefined && report.underruns.longestGapMs > thresholds.maxGapMs) {
    const noun = report.underruns.count === 1 ? 'underrun' : 'underruns';
    failures.push(
      `longest playback gap ${report.underruns.longestGapMs} ms exceeds ${thresholds.maxGapMs} ms (${report.underruns.count} ${noun})`,
    );
  }
  if (thresholds.requireBargeIn) {
    if (report.bargeIn.length === 0) {
      failures.push('barge-in was required but no interrupting turn ran');
    }
    for (const barge of report.bargeIn) {
      if (!barge.clearReceived) {
        failures.push(`turn ${barge.turn} barge-in did not receive clear`);
      } else if (barge.botAudioAfterClearMs > BARGE_AUDIO_GRACE_MS) {
        failures.push(`turn ${barge.turn} sent ${barge.botAudioAfterClearMs} ms of bot audio after clear`);
      }
    }
  }
  return failures;
}

export function reportJson(report: CallReport): Record<string, unknown> {
  return {
    ok: report.ok,
    url: report.url,
    streamSid: report.streamSid,
    callSid: report.callSid,
    accountSid: report.accountSid,
    durationMs: report.durationMs,
    timedOut: report.timedOut,
    peerClosed: report.peerClosed,
    turns: report.turns,
    underruns: report.underruns,
    formatProblems: report.formatProblems,
    formatProblemCount: report.formatProblemCount,
    bargeIn: report.bargeIn,
    marksReceived: report.marksReceived,
    marksEchoed: report.marksEchoed,
    marksPlayed: report.marksPlayed,
    marksCleared: report.marksCleared,
    unknownEvents: report.unknownEvents,
    recording: report.recording,
    thresholds: report.thresholds,
    failures: report.failures,
  };
}
