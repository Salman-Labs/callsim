import type { CheckResult, Expectation } from './types.js';

export interface ExpectInput {
  turn: number;
  expect: Expectation;
  said: string;
  heard: string;
  /** Set when this turn played caller audio or sent DTMF and a reply was timed. */
  firstAudioMs: number | null;
  /** True when this turn barged in on the agent. */
  barged: boolean;
  yieldMs: number | null;
  agentAudioAfterMs: number | null;
  /** True when a new agent utterance started after this turn's caller audio. */
  newAudio: boolean;
}

export function evaluateExpectations(input: ExpectInput): { checks: CheckResult[]; failures: string[] } {
  const checks: CheckResult[] = [];
  const failures: string[] = [];
  const { expect, turn } = input;
  const said = input.said;
  const heard = input.heard;

  if (expect.agent_says_any) {
    const ok = expect.agent_says_any.some((phrase) => includes(said, phrase));
    const detail = ok ? undefined : `turn ${turn}: agent did not say any of: ${expect.agent_says_any.join(' | ')}`;
    checks.push({ type: 'agent_says_any', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.agent_says_all) {
    const missing = expect.agent_says_all.filter((phrase) => !includes(said, phrase));
    const ok = missing.length === 0;
    const detail = ok ? undefined : `turn ${turn}: agent did not say all of: ${missing.join(' | ')}`;
    checks.push({ type: 'agent_says_all', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.agent_says_regex) {
    let ok = false;
    let detail: string | undefined;
    try {
      ok = compileRegex(expect.agent_says_regex).test(said);
      if (!ok) detail = `turn ${turn}: agent speech did not match /${expect.agent_says_regex}/`;
    } catch (err) {
      detail = `turn ${turn}: agent_says_regex is invalid (${err instanceof Error ? err.message : String(err)})`;
    }
    checks.push({ type: 'agent_says_regex', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.agent_not_says) {
    const hit = expect.agent_not_says.find((phrase) => includes(said, phrase));
    const ok = hit === undefined;
    const detail = ok ? undefined : `turn ${turn}: agent said "${hit}"`;
    checks.push({ type: 'agent_not_says', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.agent_heard) {
    const missing = expect.agent_heard.filter((phrase) => !includes(heard, phrase));
    const ok = missing.length === 0;
    const detail = ok ? undefined : `turn ${turn}: agent did not hear: ${missing.join(' | ')}`;
    checks.push({ type: 'agent_heard', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.agent_silent) {
    const ok = !input.newAudio && said.trim() === '';
    const detail = ok ? undefined : `turn ${turn}: expected silence but the agent spoke`;
    checks.push({ type: 'agent_silent', ok, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (expect.max_first_audio_ms !== undefined && input.firstAudioMs !== undefined) {
    const limit = expect.max_first_audio_ms;
    const value = input.firstAudioMs;
    const ok = value !== null && value <= limit;
    const detail = ok
      ? undefined
      : value === null
        ? `turn ${turn}: no agent audio within ${limit} ms`
        : `turn ${turn}: first audio ${value} ms exceeds ${limit} ms`;
    checks.push({ type: 'max_first_audio_ms', ok, ...(value !== null ? { value } : {}), limit, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (input.barged && expect.max_yield_ms !== undefined) {
    const limit = expect.max_yield_ms;
    const value = input.yieldMs;
    const ok = value !== null && value <= limit;
    const detail = ok
      ? undefined
      : value === null
        ? `turn ${turn}: barge-in did not land; the agent was not speaking`
        : `turn ${turn}: agent kept speaking ${value} ms after barge-in (max ${limit})`;
    checks.push({ type: 'max_yield_ms', ok, ...(value !== null ? { value } : {}), limit, ...(detail ? { detail } : {}) });
    if (detail) failures.push(detail);
  }
  if (input.barged && expect.max_agent_audio_after_barge_ms !== undefined) {
    const limit = expect.max_agent_audio_after_barge_ms;
    const value = input.agentAudioAfterMs;
    const ok = value !== null && value <= limit;
    const detail = ok ? undefined : `turn ${turn}: agent audio after barge-in ${value ?? limit} ms exceeds ${limit} ms`;
    checks.push({
      type: 'max_agent_audio_after_barge_ms',
      ok,
      ...(value !== null ? { value } : {}),
      limit,
      ...(detail ? { detail } : {}),
    });
    if (detail) failures.push(detail);
  }
  if (input.barged && expectsSpeech(expect) && !input.newAudio && !expect.agent_silent) {
    const detail = `turn ${turn}: agent was silent after the interruption`;
    checks.push({ type: 'agent_silent_after_barge', ok: false, detail });
    failures.push(detail);
  }
  return { checks, failures };
}

export function expectsSpeech(expect: Expectation | undefined): boolean {
  if (!expect || expect.agent_silent) return false;
  return Boolean(
    expect.agent_says_any ||
      expect.agent_says_all ||
      expect.agent_says_regex ||
      expect.agent_heard ||
      expect.max_first_audio_ms !== undefined,
  );
}

export function mergeExpectation(defaults: { max_first_audio_ms?: number; max_yield_ms?: number; max_agent_audio_after_barge_ms?: number } | undefined, expect: Expectation | undefined, hasCallerAudio: boolean): Expectation | undefined {
  const merged: Expectation = { ...(expect ?? {}) };
  if (hasCallerAudio && merged.max_first_audio_ms === undefined && defaults?.max_first_audio_ms !== undefined) {
    merged.max_first_audio_ms = defaults.max_first_audio_ms;
  }
  if (merged.max_yield_ms === undefined && defaults?.max_yield_ms !== undefined) merged.max_yield_ms = defaults.max_yield_ms;
  if (merged.max_agent_audio_after_barge_ms === undefined && defaults?.max_agent_audio_after_barge_ms !== undefined) {
    merged.max_agent_audio_after_barge_ms = defaults.max_agent_audio_after_barge_ms;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** JavaScript RegExp, plus a leading `(?i)` flag the way the scenario examples write it. */
export function compileRegex(pattern: string): RegExp {
  const inline = /^\(\?([a-z]+)\)/.exec(pattern);
  if (!inline) return new RegExp(pattern);
  const source = pattern.slice(inline[0].length);
  let flags = '';
  if (inline[1]!.includes('i')) flags += 'i';
  if (inline[1]!.includes('m')) flags += 'm';
  if (inline[1]!.includes('s')) flags += 's';
  return new RegExp(source, flags);
}
