/**
 * Transport-neutral scripted caller.
 *
 * A transport joins one voice agent as the caller and plays a fixed script.
 * The scenario runner (`callsim run`) talks only to this interface, so Twilio
 * Media Streams, Vapi, Retell, SIP, and LiveKit can plug in later without a
 * new scenario format. LiveKit is `src/livekit/transport.ts`. Twilio Media
 * Streams is `src/twilio/transport.ts` and reuses the simulator's protocol,
 * μ-law frames, and playback clock. `simulateCall` remains the one-shot API.
 *
 * Methods:
 * - `connect` joins the call. It must not print API keys, secrets, or tokens.
 * - `waitForAgent` resolves when the agent is present and its audio can be heard.
 * - `playCallerAudio` plays mono PCM and resolves when that audio has actually
 *   played out, not when it has merely been queued. LiveKit's
 *   `AudioSource.captureFrame` returns ahead of real time; the LiveKit adapter
 *   waits on `waitForPlayout()`.
 * - `sendDtmf` sends `0-9`, `*`, and `#`.
 * - `onAgentAudio` is the agent's audio stream. `onAgentVad` is an energy VAD
 *   over that stream: `start` on the first loud frame, `stop` once energy has
 *   stayed under the threshold for the hangover (200 ms). `stop.atMs` is the
 *   start of the quiet period, not the end of the hangover.
 * - `onAgentTranscript` is what the agent said. `onCallerHeard` is what the
 *   agent heard the caller say, when the platform provides it (LiveKit:
 *   `lk.transcription` tagged with the caller track). Either may be silent.
 * - `hangup` leaves the call and releases the room or session. It is idempotent.
 */

export interface Transport {
  readonly name: string;

  connect(options: TransportConnectOptions): Promise<void>;

  /**
   * Resolve when the agent is in the call and its audio track is available.
   * Reject on timeout. `joinedMs` is milliseconds since `connect` started.
   */
  waitForAgent(timeoutMs: number): Promise<AgentPresence>;

  /** Play caller PCM. Resolve at real playout end, not at enqueue. */
  playCallerAudio(audio: CallerAudio): Promise<CallerPlayout>;

  /** RFC 4733 digits: `0-9`, `*`, `#`. */
  sendDtmf(digits: string): Promise<void>;

  /** Agent PCM as it arrives. `atMs` is milliseconds since `connect` started. */
  onAgentAudio(listener: (frame: AgentAudioFrame) => void): () => void;

  /** Energy VAD over the agent audio stream. */
  onAgentVad(listener: (event: AgentVadEvent) => void): () => void;

  /** What the agent said. */
  onAgentTranscript(listener: (event: TranscriptEvent) => void): () => void;

  /** What the agent heard the caller say, when the platform exposes it. */
  onCallerHeard(listener: (event: TranscriptEvent) => void): () => void;

  /**
   * Platform agent state, if any. LiveKit reads `lk.agent.state`
   * (`listening`, `thinking`, or `speaking`). Null when the platform has none.
   */
  agentState(): string | null;

  /** Milliseconds since `connect` started. Monotonic. */
  now(): number;

  /** Room or call id assigned at connect. */
  roomId(): string | undefined;

  /** Non-fatal notes, such as a SIP-kind fallback. */
  warnings(): readonly string[];

  /** Leave the call and release server-side resources. Idempotent. */
  hangup(): Promise<void>;

  /**
   * True when the platform already supplies what the agent said and heard.
   * Twilio does not; a scenario can add `stt:` or the says/heard checks are skipped.
   */
  hasNativeTranscript(): boolean;

  /** Platform counters. Twilio fills `twilio`. */
  snapshot(): TransportSnapshot;
}

export interface TwilioCallStats {
  streamSid: string;
  callSid: string;
  underruns: { count: number; longestGapMs: number; gapsMs: number[] };
  marks: { received: number; echoed: number; played: number; cleared: number };
  formatProblemCount: number;
  clears: { atMs: number; msFromBarge: number | null; agentAudioAfterMs: number }[];
}

export interface TransportSnapshot {
  twilio?: TwilioCallStats;
}

export interface TransportConnectOptions {
  /** Stable id for this run, used in room names. */
  runId: string;
  /** Scenario label, sanitized into the room name. */
  label: string;
  /** The scenario file's transport block (`livekit:`, later `twilio:`). */
  config: Record<string, unknown>;
  /** Scenario `userdata`, forwarded as dispatch metadata when the platform has it. */
  userdata?: unknown;
  signal?: AbortSignal;
  onEvent?: (event: TransportLogEvent) => void;
}

export interface AgentPresence {
  identity: string;
  joinedMs: number;
}

export interface CallerAudio {
  /** Mono PCM 16-bit. */
  pcm: Int16Array;
  sampleRate: number;
}

export interface CallerPlayout {
  /** Media duration of the clip. */
  audioMs: number;
  /** Milliseconds from connect start to the first queued frame. */
  startedAtMs: number;
  /** Milliseconds from connect start to real playout end. */
  endedAtMs: number;
  /** Set when this clip started while the agent was still playing. Twilio fills it from `clear`. */
  barge?: { clearReceived: boolean; msToClear: number | null; agentAudioAfterMs: number };
}

export interface AgentAudioFrame {
  pcm: Int16Array;
  sampleRate: number;
  /** Start of this frame, milliseconds since connect. */
  atMs: number;
}

export interface AgentVadEvent {
  type: 'start' | 'stop';
  atMs: number;
  /** Set on stop: how long the utterance stayed above the energy threshold. */
  speechMs?: number;
}

export interface TranscriptEvent {
  text: string;
  final: boolean;
  atMs: number;
  segmentId?: string;
}

export interface TransportLogEvent {
  t: number;
  type: string;
  [key: string]: unknown;
}
