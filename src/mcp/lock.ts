const DEFAULT_LIMIT = 1;

let active = 0;

export function runCapacity(): number {
  const raw = process.env.CALLSIM_MAX_RUNS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT;
  return Math.floor(value);
}

/** Returns false when a run is already using the only slot. */
export function beginRun(): boolean {
  if (active >= runCapacity()) return false;
  active += 1;
  return true;
}

export function endRun(): void {
  active = Math.max(0, active - 1);
}

export const RUN_BUSY = 'A scenario run is already in progress. callsim runs one scenario at a time by default.';
