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
