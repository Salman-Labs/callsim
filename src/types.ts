/** One caller turn. Provide exactly one audio source. */
export interface TurnInput {
  /** Spoken with a bundled fixture or the built-in formant synthesizer. */
  text?: string;
  /** Path to a PCM or μ-law WAV. Resampled to 8 kHz mono. */
  wavPath?: string;
  /** Raw 8 kHz μ-law bytes. */
  mulaw?: Uint8Array;
  /** PCM 16-bit mono. `sampleRate` defaults to 8000. */
  pcm16?: Int16Array;
  sampleRate?: number;
  /** Label in the report. Defaults to the text, file name, or "audio". */
  label?: string;
}

export interface Thresholds {
  /** Fail when any turn's first bot audio is slower than this, or missing. */
  maxFirstAudioMs?: number;
  /** Fail when the longest mid-utterance playback gap exceeds this. */
  maxGapMs?: number;
  /**
   * Fail unless every interrupting turn receives `clear` and the bot stops
   * sending audio (one in-flight frame is allowed).
   */
  requireBargeIn?: boolean;
}

export interface TurnMetric {
  /** 1-based turn index. */
  turn: number;
  label: string;
  /**
   * Milliseconds from the end of this caller turn to the start of the next
   * bot utterance. Null when the bot never started a new utterance.
   */
  firstAudioMs: number | null;
}

export interface BargeInMetric {
  /** 1-based index of the caller turn that interrupted. */
  turn: number;
  clearReceived: boolean;
  /** Milliseconds from the first interrupting frame to `clear`. */
  msToClear: number | null;
  /**
   * Bot media duration received after `clear` and before this caller turn
   * finished. A later reply, after the caller stops, is not included.
   */
  botAudioAfterClearMs: number;
}

export type FormatProblemKind =
  | 'invalid-json'
  | 'invalid-message'
  | 'invalid-base64'
  | 'empty-payload'
  | 'non-mulaw'
  | 'unexpected-frame-size'
  | 'missing-stream-sid'
  | 'stream-sid-mismatch';

export interface FormatProblem {
  kind: FormatProblemKind;
  detail: string;
}

export interface UnderrunMetric {
  count: number;
  longestGapMs: number;
  gapsMs: number[];
}

export interface RecordingInfo {
  sampleRate: 8000;
  channels: 2;
  bitsPerSample: 16;
  /** Left is the caller, right is bot audio at the simulated play head. */
  layout: 'stereo-caller-left-bot-right';
  durationMs: number;
  bytes: number;
  path?: string;
}

export interface CallReport {
  url: string;
  streamSid: string;
  callSid: string;
  accountSid: string;
  durationMs: number;
  timedOut: boolean;
  peerClosed: boolean;
  turns: TurnMetric[];
  underruns: UnderrunMetric;
  formatProblems: FormatProblem[];
  /** Count of format problems, including ones omitted from `formatProblems`. */
  formatProblemCount: number;
  bargeIn: BargeInMetric[];
  /** Marks the bot sent us. */
  marksReceived: number;
  /** Marks we echoed, either because playback reached them or because of clear. */
  marksEchoed: number;
  /** Echoed when the preceding audio finished playing. */
  marksPlayed: number;
  /** Echoed immediately because `clear` discarded the audio in front of them. */
  marksCleared: number;
  unknownEvents: number;
  recording: RecordingInfo;
  /** Stereo 8 kHz 16-bit WAV. Left caller, right bot. */
  recordingWav: Buffer;
  thresholds: Thresholds | null;
  failures: string[];
  ok: boolean;
}

export interface SimulateCallOptions {
  /** `ws://` or `wss://` URL of the bot's Media Stream server. `http(s)` is rewritten. */
  url: string;
  turns: TurnInput[];
  /**
   * Seconds after the bot starts speaking before each later turn begins.
   * The interrupting turn overlaps playback so barge-in can be measured.
   * Omit to wait until the bot finishes, then apply `silence`.
   */
  bargeIn?: number;
  /** Seconds to wait after the bot finishes, before the next non-interrupting turn. */
  silence?: number;
  /** Whole-call limit in seconds. */
  timeout?: number;
  /** Copied into `start.start.customParameters`. */
  params?: Record<string, string>;
  /**
   * Extra random delay, up to this many milliseconds, added to each caller
   * frame. Frames stay in order. `0` sends on a monotonic 20 ms clock.
   */
  jitter?: number;
  /** DTMF digits (`0-9`, `*`, `#`) sent after the last caller turn. */
  dtmf?: string;
  /** Write the stereo WAV here as well as returning it. */
  out?: string;
  thresholds?: Thresholds;
  /** Override the underrun noise floor. */
  underrunFloorMs?: number;
  /**
   * How long to wait for a bot utterance to start after a caller turn.
   * Once audio starts, the call waits for that utterance to finish playing.
   */
  responseGraceMs?: number;
  signal?: AbortSignal;
  streamSid?: string;
  callSid?: string;
  accountSid?: string;
}
