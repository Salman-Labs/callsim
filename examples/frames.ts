import { Buffer } from 'node:buffer';

export const FRAME_BYTES = 160;

export function splitFrames(mulaw: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < mulaw.length; offset += FRAME_BYTES) {
    const slice = mulaw.subarray(offset, Math.min(offset + FRAME_BYTES, mulaw.length));
    if (slice.length === FRAME_BYTES) {
      frames.push(Buffer.from(slice));
      continue;
    }
    const padded = Buffer.alloc(FRAME_BYTES, 0xff);
    slice.copy(padded);
    frames.push(padded);
  }
  return frames;
}

export function mediaMessage(streamSid: string, frame: Buffer): string {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: frame.toString('base64') },
  });
}

export function markMessage(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

export function clearMessage(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid });
}

export function paceFrames(options: {
  frames: Buffer[];
  leadFrames: number;
  frameMs: number;
  shouldStop: () => boolean;
  send: (frame: Buffer) => void;
}): Promise<void> {
  const { frames, leadFrames, frameMs, shouldStop, send } = options;
  const start = performance.now();
  let sent = 0;
  return new Promise((resolve) => {
    const pump = (): void => {
      if (shouldStop()) {
        resolve();
        return;
      }
      const due = leadFrames + Math.floor((performance.now() - start) / frameMs);
      while (sent < frames.length && sent < Math.max(leadFrames, due)) {
        if (shouldStop()) {
          resolve();
          return;
        }
        const frame = frames[sent];
        if (!frame) break;
        send(frame);
        sent += 1;
      }
      if (sent >= frames.length) {
        resolve();
        return;
      }
      const nextAt = start + (sent - leadFrames + 1) * frameMs;
      setTimeout(pump, Math.max(5, nextAt - performance.now()));
    };
    pump();
  });
}
