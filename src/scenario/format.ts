import type { ScenarioReport } from './types.js';

export function formatScenarioReports(reports: ScenarioReport[]): string {
  return reports.map((report) => formatScenarioReport(report)).join('\n');
}

export function formatScenarioReport(report: ScenarioReport): string {
  const lines: string[] = [];
  const result = report.ok ? 'PASS' : 'FAIL';
  lines.push(`${report.scenario}  ${result}  (${report.transport}${report.room ? `, ${report.room}` : ''})`);
  if (report.agent) lines.push(`Agent  ${report.agent.identity}  joined ${report.agent.joinedMs} ms`);
  if (report.caller) lines.push(`Caller  ${report.caller.identity}  kind ${report.caller.kind}`);
  for (const warning of report.warnings) lines.push(`Warning  ${warning}`);
  for (const turn of report.turns) {
    const caller = turn.caller?.text ?? '—';
    const first = turn.agent.firstAudioMs === null ? '—' : `${turn.agent.firstAudioMs} ms`;
    const said = turn.agent.said ? `  "${clip(turn.agent.said)}"` : '';
    lines.push(`Turn ${turn.i}  ${caller}  first audio ${first}${said}`);
    const barge = report.bargeIn.find((item) => item.turn === turn.i);
    if (barge) {
      lines.push(`  barge-in  yield ${barge.yieldMs} ms, agent audio after ${barge.agentAudioAfterMs} ms`);
    }
  }
  if (report.latency) {
    const latency = report.latency.firstAudioMs;
    lines.push(`First audio  p50 ${latency.p50} ms  p95 ${latency.p95} ms  max ${latency.max} ms`);
  }
  if (report.judge) lines.push(`Judge  ${report.judge.skipped ? 'skipped' : report.judge.ok ? 'pass' : 'fail'}${report.judge.reason ? `  ${report.judge.reason}` : ''}`);
  if (report.verify) lines.push(`Verify  ${report.verify.ok ? 'pass' : 'fail'}`);
  lines.push(`Result  ${result}`);
  for (const failure of report.failures) lines.push(`- ${failure}`);
  if (report.artifacts.wav) lines.push(`WAV  ${report.artifacts.wav}`);
  return lines.join('\n');
}

function clip(text: string): string {
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}
