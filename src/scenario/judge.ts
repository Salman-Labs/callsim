import { scrubSecrets } from './errors.js';
import type { JudgeResult, ReportTranscriptLine } from './types.js';

/**
 * Optional LLM rubric. Non-gating unless the CLI is passed `--judge-required`.
 * With neither OPENAI_API_KEY nor OPENAI_BASE_URL, the judge is skipped.
 */
export async function runJudge(rubric: string, transcript: ReportTranscriptLine[]): Promise<JudgeResult> {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL?.replace(/\/$/, '');
  if (!key && !base) {
    return { ran: false, skipped: true, ok: null, reason: 'skipped: no OPENAI_API_KEY or OPENAI_BASE_URL' };
  }
  const url = `${base || 'https://api.openai.com/v1'}/chat/completions`;
  const lines = transcript.map((line) => `${line.role}: ${line.text}`).join('\n');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.CALLSIM_JUDGE_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You grade a voice-agent transcript against a rubric. Reply with JSON only: {"ok": true or false, "reason": "short"}.',
          },
          { role: 'user', content: `Rubric:\n${rubric}\n\nTranscript:\n${lines || '(empty)'}` },
        ],
      }),
    });
  } catch (err) {
    return {
      ran: true,
      ok: false,
      reason: `judge request failed: ${scrubSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
  if (!response.ok) {
    const body = scrubSecrets(await response.text()).slice(0, 300);
    return { ran: true, ok: false, reason: `judge HTTP ${response.status}: ${body}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ran: true, ok: false, reason: 'judge response was not JSON' };
  }
  const text = extractContent(payload);
  const parsed = parseVerdict(text);
  if (!parsed) return { ran: true, ok: false, reason: 'judge response had no ok boolean' };
  return { ran: true, ok: parsed.ok, reason: parsed.reason };
}

function extractContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  return typeof message?.content === 'string' ? message.content : '';
}

function parseVerdict(text: string): { ok: boolean; reason?: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as { ok?: unknown; reason?: unknown };
    if (typeof obj.ok !== 'boolean') return null;
    return { ok: obj.ok, ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}) };
  } catch {
    return null;
  }
}
