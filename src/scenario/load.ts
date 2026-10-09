import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { interpolateEnv } from './env.js';
import { ScenarioUsageError } from './errors.js';
import type {
  Expectation,
  LiveKitFileConfig,
  ScenarioCase,
  ScenarioDefaults,
  ScenarioFile,
  ScenarioTurn,
  ScenarioVerify,
  SttConfig,
  TwilioFileConfig,
  VoiceConfig,
} from './types.js';

export function loadScenarioFiles(inputs: string[], cwd = process.cwd()): ScenarioFile[] {
  const paths = expandInputs(inputs, cwd);
  if (paths.length === 0) throw new ScenarioUsageError('No scenario files were given');
  return paths.map((path) => loadScenarioFile(path));
}

export function loadScenarioFile(path: string): ScenarioFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ScenarioUsageError(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new ScenarioUsageError(`${path} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScenarioUsageError(`${path} must be a YAML mapping`);
  }
  const data = interpolateEnv(parsed as Record<string, unknown>, path);
  return loadScenarioDocument(data, path);
}

/** Validate an already-parsed scenario document. `path` is used only in error text. */
export function loadScenarioDocument(data: Record<string, unknown>, path: string): ScenarioFile {
  const transport = requiredString(data.transport, `${path} transport`);
  const scenarios = data.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new ScenarioUsageError(`${path} needs a non-empty scenarios list`);
  }
  return {
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    transport,
    ...(data.livekit !== undefined ? { livekit: livekitConfig(data.livekit, `${path} livekit`) } : {}),
    ...(data.twilio !== undefined ? { twilio: twilioConfig(data.twilio, `${path} twilio`) } : {}),
    ...(data.voice !== undefined ? { voice: voiceConfig(data.voice, `${path} voice`) } : {}),
    ...(data.stt !== undefined ? { stt: sttConfig(data.stt, `${path} stt`) } : {}),
    ...(data.defaults !== undefined ? { defaults: defaultsConfig(data.defaults, `${path} defaults`) } : {}),
    scenarios: scenarios.map((item, index) => scenarioCase(item, `${path} scenarios[${index}]`)),
    dir: resolve(path, '..'),
    path,
  };
}

export function expandInputs(inputs: string[], cwd: string): string[] {
  const found: string[] = [];
  for (const input of inputs) {
    if (!hasMagic(input)) {
      const abs = resolve(cwd, input);
      try {
        if (!statSync(abs).isFile()) throw new ScenarioUsageError(`${input} is not a file`);
      } catch (err) {
        if (err instanceof ScenarioUsageError) throw err;
        throw new ScenarioUsageError(`No scenario file at ${input}`);
      }
      found.push(abs);
      continue;
    }
    const matches = walkMatch(cwd, input);
    if (matches.length === 0) throw new ScenarioUsageError(`No scenario files matched ${input}`);
    found.push(...matches);
  }
  return [...new Set(found)];
}

function walkMatch(cwd: string, pattern: string): string[] {
  const out: string[] = [];
  const regex = globToRegExp(pattern.split('\\').join('/'));
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(cwd, abs).split('\\').join('/');
      if (st.isDirectory()) visit(abs);
      else if (regex.test(rel)) out.push(abs);
    }
  };
  visit(cwd);
  return out.sort();
}

function hasMagic(input: string): boolean {
  return /[*?]/.test(input);
}

function globToRegExp(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else src += '[^/]*';
      continue;
    }
    if (char === '?') {
      src += '[^/]';
      continue;
    }
    src += /[|\\{}()[\]^$+.]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${src}$`);
}

function scenarioCase(value: unknown, where: string): ScenarioCase {
  const obj = mapping(value, where);
  const turns = obj.turns;
  if (!Array.isArray(turns) || turns.length === 0) throw new ScenarioUsageError(`${where}.turns must be a non-empty list`);
  const tags = obj.tags === undefined ? undefined : stringMap(obj.tags, `${where}.tags`);
  return {
    label: requiredString(obj.label, `${where}.label`),
    ...(tags ? { tags } : {}),
    ...(obj.userdata !== undefined ? { userdata: obj.userdata } : {}),
    turns: turns.map((turn, index) => scenarioTurn(turn, `${where}.turns[${index}]`)),
    ...(obj.judge !== undefined ? { judge: requiredString(obj.judge, `${where}.judge`) } : {}),
    ...(obj.verify !== undefined ? { verify: scenarioVerify(obj.verify, `${where}.verify`) } : {}),
  };
}

function scenarioTurn(value: unknown, where: string): ScenarioTurn {
  const obj = mapping(value, where);
  const turn: ScenarioTurn = {};
  if (obj.say !== undefined) turn.say = requiredString(obj.say, `${where}.say`);
  if (obj.audio !== undefined) turn.audio = requiredString(obj.audio, `${where}.audio`);
  if (obj.dtmf !== undefined) {
    const digits = requiredString(obj.dtmf, `${where}.dtmf`);
    if (!/^[0-9*#]+$/.test(digits)) throw new ScenarioUsageError(`${where}.dtmf must contain only 0-9, *, and #`);
    turn.dtmf = digits;
  }
  if (obj.wait_ms !== undefined) turn.wait_ms = nonNegative(obj.wait_ms, `${where}.wait_ms`);
  if (obj.silence_ms !== undefined) turn.silence_ms = nonNegative(obj.silence_ms, `${where}.silence_ms`);
  if (obj.barge_in_after_ms !== undefined) turn.barge_in_after_ms = nonNegative(obj.barge_in_after_ms, `${where}.barge_in_after_ms`);
  if (obj.expect !== undefined) turn.expect = expectation(obj.expect, `${where}.expect`);
  if (obj.hangup !== undefined) turn.hangup = bool(obj.hangup, `${where}.hangup`);
  if (turn.say !== undefined && turn.audio !== undefined) {
    throw new ScenarioUsageError(`${where} has both say and audio`);
  }
  return turn;
}

function expectation(value: unknown, where: string): Expectation {
  const obj = mapping(value, where);
  const expect: Expectation = {};
  if (obj.agent_says_any !== undefined) expect.agent_says_any = stringList(obj.agent_says_any, `${where}.agent_says_any`);
  if (obj.agent_says_all !== undefined) expect.agent_says_all = stringList(obj.agent_says_all, `${where}.agent_says_all`);
  if (obj.agent_says_regex !== undefined) expect.agent_says_regex = requiredString(obj.agent_says_regex, `${where}.agent_says_regex`);
  if (obj.agent_not_says !== undefined) expect.agent_not_says = stringList(obj.agent_not_says, `${where}.agent_not_says`);
  if (obj.agent_heard !== undefined) expect.agent_heard = stringList(obj.agent_heard, `${where}.agent_heard`);
  if (obj.agent_silent !== undefined) expect.agent_silent = bool(obj.agent_silent, `${where}.agent_silent`);
  if (obj.max_first_audio_ms !== undefined) expect.max_first_audio_ms = nonNegative(obj.max_first_audio_ms, `${where}.max_first_audio_ms`);
  if (obj.max_yield_ms !== undefined) expect.max_yield_ms = nonNegative(obj.max_yield_ms, `${where}.max_yield_ms`);
  if (obj.require_clear !== undefined) expect.require_clear = bool(obj.require_clear, `${where}.require_clear`);
  if (obj.max_gap_ms !== undefined) expect.max_gap_ms = nonNegative(obj.max_gap_ms, `${where}.max_gap_ms`);
  if (obj.max_agent_audio_after_barge_ms !== undefined) {
    expect.max_agent_audio_after_barge_ms = nonNegative(obj.max_agent_audio_after_barge_ms, `${where}.max_agent_audio_after_barge_ms`);
  }
  return expect;
}

function scenarioVerify(value: unknown, where: string): ScenarioVerify {
  const obj = mapping(value, where);
  if (obj.run !== undefined) {
    return {
      run: requiredString(obj.run, `${where}.run`),
      ...(obj.expect_exit !== undefined ? { expect_exit: numberValue(obj.expect_exit, `${where}.expect_exit`) } : {}),
    };
  }
  if (obj.http !== undefined) {
    const http = mapping(obj.http, `${where}.http`);
    const headers = http.headers === undefined ? undefined : stringMap(http.headers, `${where}.http.headers`);
    const expectJson = http.expect_json === undefined ? undefined : jsonMap(http.expect_json, `${where}.http.expect_json`);
    return {
      http: {
        url: requiredString(http.url, `${where}.http.url`),
        ...(http.method !== undefined ? { method: requiredString(http.method, `${where}.http.method`) } : {}),
        ...(headers ? { headers } : {}),
        ...(http.expect_status !== undefined ? { expect_status: numberValue(http.expect_status, `${where}.http.expect_status`) } : {}),
        ...(expectJson ? { expect_json: expectJson } : {}),
      },
    };
  }
  throw new ScenarioUsageError(`${where} needs run or http`);
}

function twilioConfig(value: unknown, where: string): TwilioFileConfig {
  const obj = mapping(value, where);
  const params = obj.params === undefined ? undefined : stringMap(obj.params, `${where}.params`);
  return {
    ...(obj.url !== undefined ? { url: requiredString(obj.url, `${where}.url`) } : {}),
    ...(params ? { params } : {}),
  };
}

function sttConfig(value: unknown, where: string): SttConfig {
  const obj = mapping(value, where);
  const provider = requiredString(obj.provider, `${where}.provider`);
  if (provider !== 'deepgram' && provider !== 'openai' && provider !== 'whisper-local') {
    throw new ScenarioUsageError(`${where}.provider must be deepgram, openai, or whisper-local`);
  }
  return {
    provider,
    ...(obj.model !== undefined ? { model: requiredString(obj.model, `${where}.model`) } : {}),
    ...(obj.language !== undefined ? { language: requiredString(obj.language, `${where}.language`) } : {}),
  };
}

function livekitConfig(value: unknown, where: string): LiveKitFileConfig {
  const obj = mapping(value, where);
  const caller = obj.caller === undefined ? undefined : callerConfig(obj.caller, `${where}.caller`);
  return {
    ...(obj.url !== undefined ? { url: requiredString(obj.url, `${where}.url`) } : {}),
    ...(obj.agent_name !== undefined ? { agent_name: requiredString(obj.agent_name, `${where}.agent_name`) } : {}),
    ...(obj.join_timeout_ms !== undefined ? { join_timeout_ms: nonNegative(obj.join_timeout_ms, `${where}.join_timeout_ms`) } : {}),
    ...(caller ? { caller } : {}),
  };
}

function callerConfig(value: unknown, where: string): NonNullable<LiveKitFileConfig['caller']> {
  const obj = mapping(value, where);
  let kind: 'sip' | 'standard' | undefined;
  if (obj.kind !== undefined) {
    const raw = requiredString(obj.kind, `${where}.kind`);
    if (raw !== 'sip' && raw !== 'standard') throw new ScenarioUsageError(`${where}.kind must be sip or standard`);
    kind = raw;
  }
  const attributes = obj.attributes === undefined ? undefined : stringMap(obj.attributes, `${where}.attributes`);
  return {
    ...(kind ? { kind } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function voiceConfig(value: unknown, where: string): VoiceConfig {
  const obj = mapping(value, where);
  return {
    ...(obj.tts !== undefined ? { tts: requiredString(obj.tts, `${where}.tts`) } : {}),
    ...(obj.voice !== undefined ? { voice: requiredString(obj.voice, `${where}.voice`) } : {}),
    ...(obj.cache !== undefined ? { cache: requiredString(obj.cache, `${where}.cache`) } : {}),
    ...(obj.phone_band !== undefined ? { phone_band: bool(obj.phone_band, `${where}.phone_band`) } : {}),
  };
}

function defaultsConfig(value: unknown, where: string): ScenarioDefaults {
  const obj = mapping(value, where);
  return {
    ...(obj.max_first_audio_ms !== undefined ? { max_first_audio_ms: nonNegative(obj.max_first_audio_ms, `${where}.max_first_audio_ms`) } : {}),
    ...(obj.max_yield_ms !== undefined ? { max_yield_ms: nonNegative(obj.max_yield_ms, `${where}.max_yield_ms`) } : {}),
    ...(obj.max_agent_audio_after_barge_ms !== undefined
      ? { max_agent_audio_after_barge_ms: nonNegative(obj.max_agent_audio_after_barge_ms, `${where}.max_agent_audio_after_barge_ms`) }
      : {}),
    ...(obj.max_gap_ms !== undefined ? { max_gap_ms: nonNegative(obj.max_gap_ms, `${where}.max_gap_ms`) } : {}),
    ...(obj.silence_ms !== undefined ? { silence_ms: nonNegative(obj.silence_ms, `${where}.silence_ms`) } : {}),
  };
}

function mapping(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScenarioUsageError(`${where} must be a mapping`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ScenarioUsageError(`${where} must be a string`);
  return value;
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ScenarioUsageError(`${where} must be a list of strings`);
  }
  return value as string[];
}

function stringMap(value: unknown, where: string): Record<string, string> {
  const obj = mapping(value, where);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(obj)) {
    if (typeof item === 'string') out[key] = item;
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
    else throw new ScenarioUsageError(`${where}.${key} must be a string`);
  }
  return out;
}

function jsonMap(value: unknown, where: string): Record<string, unknown> {
  return mapping(value, where);
}

function nonNegative(value: unknown, where: string): number {
  const number = numberValue(value, where);
  if (number < 0) throw new ScenarioUsageError(`${where} must be >= 0`);
  return number;
}

function numberValue(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ScenarioUsageError(`${where} must be a number`);
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new ScenarioUsageError(`${where} must be a boolean`);
  return value;
}
