import { BARGE_AUDIO_GRACE_MS } from './constants.js';
import type { CallReport, Thresholds } from './types.js';

const ANSI = /\x1b\[[0-9;]*m/g;

export function formatReport(report: CallReport, color: boolean): string {
  const paint = (text: string, code: string): string => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const good = (text: string): string => paint(text, '32');
  const bad = (text: string): string => paint(text, '31');
  const dim = (text: string): string => paint(text, '2');
  const bold = (text: string): string => paint(text, '1');

  const maxFirst = report.thresholds?.maxFirstAudioMs;
  const header = [bold('Turn'), bold('Caller'), bold('First audio'), bold('Barge-in')];
  const body = report.turns.map((turn) => {
    const barge = report.bargeIn.find((item) => item.turn === turn.turn);
    const first =
      turn.firstAudioMs === null
        ? bad('none')
        : maxFirst !== undefined && turn.firstAudioMs > maxFirst
          ? bad(`${turn.firstAudioMs} ms`)
          : turn.firstAudioMs > 1500
            ? bad(`${turn.firstAudioMs} ms`)
            : good(`${turn.firstAudioMs} ms`);
    let bargeText = dim('—');
    if (barge) {
      const clearIn = barge.msToClear === null ? '?' : barge.msToClear === 0 ? '<1' : String(barge.msToClear);
      if (!barge.clearReceived) bargeText = bad('no clear');
      else if (barge.botAudioAfterClearMs > BARGE_AUDIO_GRACE_MS) {
        bargeText = bad(`clear in ${clearIn} ms, ${barge.botAudioAfterClearMs} ms after`);
      } else {
        bargeText = good(`clear in ${clearIn} ms, ${barge.botAudioAfterClearMs} ms after`);
      }
    }
    return [String(turn.turn), turn.label, first, bargeText];
  });
  const widths = header.map((cell, index) => {
    const cells = [cell, ...body.map((row) => row[index] ?? '')];
    return Math.max(...cells.map(visibleLength));
  });
  const lines = [
    `${bold('callsim')} ${dim(report.url)}`,
    '',
    align(header, widths),
    align(
      widths.map((width) => dim('─'.repeat(width))),
      widths,
    ),
    ...(body.length > 0 ? body.map((row) => align(row, widths)) : [dim('  no turns')]),
    '',
    metric(
      'Underruns',
      report.underruns.count === 0
        ? good(`0 (longest gap 0 ms)`)
        : bad(`${report.underruns.count} (longest gap ${report.underruns.longestGapMs} ms)`),
    ),
    metric(
      'Format problems',
      report.formatProblemCount === 0 ? good('0') : bad(String(report.formatProblemCount)),
    ),
    metric(
      'Marks echoed',
      `${report.marksEchoed}  ${dim(`(${report.marksPlayed} played, ${report.marksCleared} cleared, ${report.marksReceived} from bot)`)}`,
    ),
    metric('Duration', `${(report.durationMs / 1000).toFixed(3)} s`),
    metric('Result', report.ok ? good('PASS') : bad('FAIL')),
  ];
  if (report.formatProblemCount > 0) {
    const sample = report.formatProblems
      .slice(0, 3)
      .map((problem) => `  - ${problem.kind}: ${problem.detail}`)
      .join('\n');
    lines.push(sample);
  }
  if (report.failures.length > 0) {
    lines.push('');
    for (const failure of report.failures) lines.push(bad(`- ${failure}`));
  }
  return lines.join('\n');
}

function metric(label: string, value: string): string {
  return `${label.padEnd(16)} ${value}`;
}

function align(cells: string[], widths: number[]): string {
  return cells
    .map((cell, index) => (index === cells.length - 1 ? cell : pad(cell, widths[index] ?? 0)))
    .join('  ');
}

function pad(value: string, width: number): string {
  const extra = width - visibleLength(value);
  return extra > 0 ? value + ' '.repeat(extra) : value;
}

function visibleLength(value: string): number {
  return value.replace(ANSI, '').length;
}

export function thresholdsActive(thresholds: Thresholds | null | undefined): boolean {
  if (!thresholds) return false;
  return (
    thresholds.maxFirstAudioMs !== undefined ||
    thresholds.maxGapMs !== undefined ||
    thresholds.requireBargeIn === true
  );
}
