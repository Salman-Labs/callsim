/** 8 kHz telephony rate used by Twilio Media Streams. */
export const SAMPLE_RATE = 8000;

/** Twilio's recommended media frame duration. */
export const FRAME_MS = 20;

/** Bytes in one 20 ms mono μ-law frame at 8 kHz. */
export const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS) / 1000;

/**
 * Playback gaps shorter than this are event-loop noise, not underruns.
 * Real pacing bugs (a frame budget that drifts, or a burst then a stall)
 * land well above one frame.
 */
export const UNDERRUN_FLOOR_MS = 35;

/**
 * How long a drained playback buffer stays "the same utterance" while we
 * wait to see if more audio shows up. Longer than a buggy inter-burst gap,
 * shorter than a human pause between turns.
 */
export const UTTERANCE_SETTLE_MS = 450;

/**
 * Audio that arrives within this window after `clear` is treated as one
 * in-flight frame, not as a bot that ignored the interrupt.
 */
export const BARGE_AUDIO_GRACE_MS = 40;

export const DEFAULT_SILENCE_SEC = 0.5;
export const DEFAULT_TIMEOUT_SEC = 30;
export const DEFAULT_RESPONSE_GRACE_MS = 2500;

export const CI_DEFAULT_MAX_FIRST_AUDIO_MS = 1500;
export const CI_DEFAULT_MAX_GAP_MS = 100;
