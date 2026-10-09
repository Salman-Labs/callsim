import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { missingEnvNames } from './env.js';
import { scrubSecrets, ScenarioUsageError } from './errors.js';
import { loadScenarioDocument } from './load.js';

export interface ScenarioValidation {
  ok: boolean;
  file: string;
  transport?: string;
  labels: string[];
  errors: string[];
  /** Env var names that are referenced and unset. Values are never included. */
  missingEnv: string[];
}

export function validateScenarioFile(file: string, cwd = process.cwd()): ScenarioValidation {
  const path = resolve(cwd, file);
  const display = relative(cwd, path).split('\\').join('/') || file;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      ok: false,
      file: display,
      labels: [],
      errors: [scrubSecrets(err instanceof Error ? err.message : String(err))],
      missingEnv: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    return {
      ok: false,
      file: display,
      labels: [],
      errors: [scrubSecrets(`${display} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`)],
      missingEnv: [],
    };
  }
  const missingEnv = missingEnvNames(parsed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, file: display, labels: [], errors: [`${display} must be a YAML mapping`], missingEnv };
  }
  try {
    const loaded = loadScenarioDocument(replaceEnvRefs(parsed) as Record<string, unknown>, path);
    return {
      ok: missingEnv.length === 0,
      file: display,
      transport: loaded.transport,
      labels: loaded.scenarios.map((scenario) => scenario.label),
      errors: missingEnv.length === 0 ? [] : missingEnv.map((name) => `${name} is not set`),
      missingEnv,
    };
  } catch (err) {
    const message = err instanceof ScenarioUsageError || err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      file: display,
      labels: [],
      errors: [scrubSecrets(message)],
      missingEnv,
    };
  }
}

function replaceEnvRefs(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, 'x');
  if (Array.isArray(value)) return value.map((item) => replaceEnvRefs(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = replaceEnvRefs(item);
    return out;
  }
  return value;
}
