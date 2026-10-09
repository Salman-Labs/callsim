import type { ScenarioReport } from './types.js';

export function junitXml(reports: ScenarioReport[]): string {
  const failures = reports.filter((report) => !report.ok && !report.error).length;
  const errors = reports.filter((report) => report.error).length;
  const cases = reports.map((report) => testCase(report)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="callsim" tests="${reports.length}" failures="${failures}" errors="${errors}">\n${cases}\n</testsuite>\n`;
}

function testCase(report: ScenarioReport): string {
  const time = ((report.durationMs ?? 0) / 1000).toFixed(3);
  const attrs = `classname="${escapeXml(report.file)}" name="${escapeXml(report.scenario)}" time="${time}"`;
  if (report.error) {
    return `  <testcase ${attrs}>\n    <error message="${escapeXml(report.error.message)}" type="${escapeXml(report.error.code)}">${escapeXml(report.error.message)}</error>\n  </testcase>`;
  }
  if (!report.ok) {
    const message = report.failures[0] ?? 'failed';
    const body = report.failures.join('\n');
    return `  <testcase ${attrs}>\n    <failure message="${escapeXml(message)}">${escapeXml(body)}</failure>\n  </testcase>`;
  }
  return `  <testcase ${attrs}/>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
