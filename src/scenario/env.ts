import { ScenarioUsageError } from './errors.js';

const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replace `${VAR}` with the process environment. Missing names are an error; values are never included in the error. */
export function interpolateEnv<T>(value: T, where: string): T {
  return walk(value, where) as T;
}

function walk(value: unknown, where: string): unknown {
  if (typeof value === 'string') return interpolateString(value, where);
  if (Array.isArray(value)) return value.map((item, index) => walk(item, `${where}[${index}]`));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, `${where}.${key}`);
    return out;
  }
  return value;
}

export function interpolateString(value: string, where: string): string {
  return value.replace(PATTERN, (_match, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new ScenarioUsageError(`${where} references \${${name}}, which is not set`);
    }
    return found;
  });
}

/** Names referenced as `${VAR}`. Values are never read. */
export function referencedEnvNames(value: unknown): string[] {
  const names = new Set<string>();
  collectEnvNames(value, names);
  return [...names].sort();
}

export function missingEnvNames(value: unknown): string[] {
  return referencedEnvNames(value).filter((name) => process.env[name] === undefined);
}

function collectEnvNames(value: unknown, names: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PATTERN)) names.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvNames(item, names);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectEnvNames(item, names);
  }
}
