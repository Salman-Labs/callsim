/**
 * A bot that sounds fine in a unit test and bad on a phone.
 *
 * Two deliberate bugs:
 * - The reply is late, then sent in short bursts with gaps longer than the
 *   audio those bursts contain, so Twilio's playback buffer runs dry.
 * - Caller audio during playback is ignored. There is no `clear`, so the
 *   first reply keeps going through a barge-in.
 */
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { markMessage, mediaMessage, splitFrames } from './frames.js';
import { listen, type BotServer } from './server.js';

const VAD_MS = 40;
const RESPONSE_DELAY_MS = 550;
const BURST_FRAMES = 4;
const BURST_GAP_MS = 200;

export function startBuggyBot(options: { port?: number } = {}): Promise<BotServer> {
  return listen(options.port ?? 0, (ws) => attach(ws));
}

function attach(ws: WebSocket): void {
  let streamSid = '';
  let collecting = Buffer.alloc(0);
  let pending: Buffer[] = [];
  let playing = false;
  let vad: NodeJS.Timeout | null = null;
  let response = 0;

  const send = (payload: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };

  const drain = async (): Promise<void> => {
    if (playing) return;
    playing = true;
    try {
      while (pending.length > 0) {
        const audio = pending.shift();
        if (audio) await slowPlay(audio);
      }
    } finally {
      playing = false;
      if (pending.length > 0) void drain();
    }
  };

  const slowPlay = async (audio: Buffer): Promise<void> => {
    await sleep(RESPONSE_DELAY_MS);
    const frames = splitFrames(audio);
    for (let i = 0; i < frames.length; i += BURST_FRAMES) {
      for (const frame of frames.slice(i, i + BURST_FRAMES)) {
        if (frame) send(mediaMessage(streamSid, frame));
      }
      if (i + BURST_FRAMES < frames.length) await sleep(BURST_GAP_MS);
    }
    response += 1;
    send(markMessage(streamSid, `late-${response}`));
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: { event?: string; streamSid?: string; media?: { payload?: string } };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === 'start' && msg.streamSid) {
      streamSid = msg.streamSid;
      return;
    }
    if (msg.event !== 'media' || !msg.media?.payload) return;
    collecting = Buffer.concat([collecting, Buffer.from(msg.media.payload, 'base64')]);
    if (vad) clearTimeout(vad);
    vad = setTimeout(() => {
      vad = null;
      if (collecting.length === 0) return;
      pending.push(collecting);
      collecting = Buffer.alloc(0);
      void drain();
    }, VAD_MS);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const port = Number(process.env.PORT ?? 8081);
  startBuggyBot({ port })
    .then((bot) => {
      console.log(`buggy bot on ${bot.url}`);
      console.log(
        `node dist/cli.js ${bot.url} --say hello --barge-in 0.2 --ci --max-first-audio-ms 400 --max-gap-ms 40 --require-barge-in`,
      );
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
