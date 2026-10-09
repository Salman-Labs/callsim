import { scrubSecrets } from '../scenario/errors.js';

export interface KindConnectResult {
  observedKind: string;
}

/**
 * Try `sip` when the scenario asks for it. LiveKit Cloud may reject a token
 * that sets participant kind sip; self-hosted `--dev` accepts it. On rejection,
 * reconnect as `standard` and keep the same `sip.*` attributes.
 * A connect that succeeds with a different observed kind is also a fallback:
 * the existing session stays up.
 */
export async function resolveCallerKind(
  requested: 'sip' | 'standard',
  connect: (kind: 'sip' | 'standard') => Promise<KindConnectResult>,
): Promise<{ kind: string; warning?: string }> {
  if (requested !== 'sip') {
    const result = await connect('standard');
    return { kind: result.observedKind || 'standard' };
  }
  try {
    const result = await connect('sip');
    if (result.observedKind === 'sip') return { kind: 'sip' };
    const observed = result.observedKind || 'unknown';
    return {
      kind: observed,
      warning: `LiveKit accepted the token but the caller joined as ${observed} instead of sip. sip.* attributes were still set.`,
    };
  } catch (err) {
    const reason = scrubSecrets(err instanceof Error ? err.message : String(err));
    const result = await connect('standard');
    return {
      kind: result.observedKind || 'standard',
      warning: `LiveKit rejected participant kind sip (${reason}). Joined as standard with the same sip.* attributes.`,
    };
  }
}

export function kindName(kind: unknown): string {
  if (kind === 0 || kind === 'standard' || kind === 'STANDARD') return 'standard';
  if (kind === 3 || kind === 'sip' || kind === 'SIP') return 'sip';
  if (kind === 4 || kind === 'agent' || kind === 'AGENT') return 'agent';
  if (typeof kind === 'number') return String(kind);
  if (typeof kind === 'string' && kind) return kind.toLowerCase();
  return 'unknown';
}
