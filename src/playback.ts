import { SAMPLE_RATE } from './constants.js';
import { debug } from './debug.js';
import type { StereoRecording } from './recording.js';

interface AudioItem {
  type: 'audio';
  pcm: Int16Array;
  durationMs: number;
}

interface MarkItem {
  type: 'mark';
  name: string;
}

type Item = AudioItem | MarkItem;

export interface PlaybackOptions {
  underrunFloorMs: number;
  utteranceSettleMs: number;
  streamStartedAt: () => number;
  recording: StereoRecording;
  onMark: (name: string, reason: 'playback' | 'clear') => void;
  onUtteranceStart: (now: number) => void;
  onUtteranceEnd: () => void;
}

/**
 * Twilio plays queued bot audio at real time and echoes a mark once every
 * audio chunk queued before that mark has been consumed. `clear` drops the
 * buffer and echoes the remaining marks immediately.
 */
export class Playback {
  readonly gapsMs: number[] = [];
  utteranceOpen = false;

  private readonly opts: PlaybackOptions;
  private queue: Item[] = [];
  private timer: NodeJS.Timeout | null = null;
  private settleTimer: NodeJS.Timeout | null = null;
  private playing: { pcm: Int16Array; startedPerf: number; durationMs: number } | null = null;
  private starvedAt: number | null = null;
  private disposed = false;

  constructor(opts: PlaybackOptions) {
    this.opts = opts;
  }

  isIdle(): boolean {
    return !this.utteranceOpen && this.playing === null && this.queue.length === 0;
  }

  enqueueAudio(pcm: Int16Array, now: number): void {
    if (this.disposed || pcm.length === 0) return;
    const idle = this.playing === null && this.queue.length === 0;
    if (idle && this.utteranceOpen && this.starvedAt !== null) {
      const gap = now - this.starvedAt;
      if (gap >= this.opts.underrunFloorMs) {
        this.gapsMs.push(gap);
        debug(`underrun ${gap.toFixed(1)} ms`);
      }
      this.starvedAt = null;
      this.cancelSettle();
    }
    const starting = idle && !this.utteranceOpen;
    this.utteranceOpen = true;
    this.queue.push({
      type: 'audio',
      pcm,
      durationMs: (pcm.length / SAMPLE_RATE) * 1000,
    });
    if (starting) this.opts.onUtteranceStart(now);
    this.pump(now);
  }

  enqueueMark(name: string, now: number): void {
    if (this.disposed) return;
    this.queue.push({ type: 'mark', name });
    this.pump(now);
  }

  clear(now: number): void {
    if (this.disposed) return;
    this.cancelTimer();
    if (this.playing) {
      const playedMs = Math.max(0, now - this.playing.startedPerf);
      const playedSamples = Math.min(
        this.playing.pcm.length,
        Math.max(0, Math.round((playedMs * SAMPLE_RATE) / 1000)),
      );
      const atMs = this.playing.startedPerf - this.opts.streamStartedAt();
      this.opts.recording.trimBot(atMs, this.playing.pcm.length, playedSamples);
      this.playing = null;
    }
    const marks = this.queue.filter((item): item is MarkItem => item.type === 'mark');
    this.queue = [];
    debug(`clear, echoing ${marks.length} mark(s)`);
    this.closeUtterance();
    for (const mark of marks) this.opts.onMark(mark.name, 'clear');
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelSettle();
    this.queue = [];
    this.playing = null;
  }

  private pump(now: number): void {
    if (this.disposed || this.playing || this.timer) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.utteranceOpen) {
        this.starvedAt = now;
        this.armSettle();
      }
      return;
    }
    if (next.type === 'mark') {
      this.opts.onMark(next.name, 'playback');
      const moreAudio = this.queue.some((item) => item.type === 'audio');
      if (!moreAudio) this.closeUtterance();
      this.pump(performance.now());
      return;
    }
    const started = performance.now();
    this.playing = { pcm: next.pcm, startedPerf: started, durationMs: next.durationMs };
    this.opts.recording.write(1, started - this.opts.streamStartedAt(), next.pcm);
    this.arm(started + next.durationMs, () => {
      this.playing = null;
      this.pump(performance.now());
    });
  }

  private closeUtterance(): void {
    const wasOpen = this.utteranceOpen;
    this.utteranceOpen = false;
    this.starvedAt = null;
    this.cancelSettle();
    if (wasOpen) this.opts.onUtteranceEnd();
  }

  private arm(endAt: number, fn: () => void): void {
    const tick = (): void => {
      if (this.disposed) return;
      const delay = endAt - performance.now();
      if (delay > 1) {
        this.timer = setTimeout(tick, delay);
        return;
      }
      this.timer = null;
      fn();
    };
    tick();
  }

  private armSettle(): void {
    this.cancelSettle();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.disposed || this.playing || this.queue.length > 0) return;
      this.closeUtterance();
    }, this.opts.utteranceSettleMs);
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private cancelSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}
