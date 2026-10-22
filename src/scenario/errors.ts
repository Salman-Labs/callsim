/** Bad arguments, missing env, or a missing TTS cache entry. Exit 2. */
export class ScenarioUsageError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioUsageError';
  }
}

/** Could not reach the platform or the agent never joined. Exit 2. */
export class ScenarioConnectionError extends Error {
  readonly exitCode = 2 as const;

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ScenarioConnectionError';
  }
}

export function scrubSecrets(message: string): string {
  let out = message.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]');
  for (const name of ['LIVEKIT_API_SECRET', 'LIVEKIT_API_KEY', 'OPENAI_API_KEY']) {
    const value = process.env[name];
    if (value && value.length >= 6) out = out.split(value).join('[redacted]');
  }
  return out;
}

/**
 * `err.message` plus its `cause` chain. `fetch` reports every network failure as
 * `fetch failed`; the reason (an expired certificate, a refused connection) is
 * only on `cause`.
 */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    let message = current.message;
    if (!message && current instanceof AggregateError) {
      message = current.errors.map((item: unknown) => (item instanceof Error ? item.message : String(item))).join('; ');
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && !message.includes(code)) message = message ? `${message} (${code})` : code;
    if (message && !parts.includes(message)) parts.push(message);
    current = current.cause;
  }
  return parts.join(': ');
}
