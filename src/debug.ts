export function debug(message: string, extra?: unknown): void {
  if (!process.env.CALLSIM_DEBUG) return;
  if (extra === undefined) console.error(`[callsim] ${message}`);
  else console.error(`[callsim] ${message}`, extra);
}
