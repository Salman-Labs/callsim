/**
 * A well-behaved echo bot.
 *
 * It answers after a short silence, keeps about 120 ms of audio queued ahead
 * of real time (a monotonic clock, so the 20 ms budget does not drift), sends
 * a mark when the reply is fully queued, and on caller audio during playback
 * sends `clear` and stops. That is the barge-in behavior callsim rewards.
 */
import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { clearMessage, markMessage, mediaMessage, paceFrames, splitFrames } from './frames.js';
import { listen, type BotServer } from './server.js';

const VAD_MS = 40;
const LEAD_FRAMES = 6;
const FRAME_MS = 20;

export function startGoodBot(options: { port?: number } = {}): Promise<BotServer> {
  return listen(options.port ?? 0, (ws) => attach(ws));
}

function attach(ws: WebSocket): void {
  let streamSid = '';
  let inbound = Buffer.alloc(0);
  let generation = 0;
  let responding = false;
  let playbackUntilMark = false;
  let vad: NodeJS.Timeout | null = null;

  const send = (payload: string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  };

  const interrupt = (): void => {
    const wasPlaying = responding || playbackUntilMark;
    generation += 1;
    responding = false;
    playbackUntilMark = false;
    if (wasPlaying && streamSid) send(clearMessage(streamSid));
  };

  const respond = (audio: Buffer): void => {
    const myGen = ++generation;
    const frames = splitFrames(audio);
    if (frames.length === 0 || !streamSid) return;
    responding = true;
    void paceFrames({
      frames,
      leadFrames: LEAD_FRAMES,
      frameMs: FRAME_MS,
      shouldStop: () => generation !== myGen,
      send: (frame) => send(mediaMessage(streamSid, frame)),
    }).then(() => {
      if (generation !== myGen) {
        responding = false;
        return;
      }
      send(markMessage(streamSid, `response-${myGen}`));
      responding = false;
      playbackUntilMark = true;
    });
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: { event?: string; streamSid?: string; media?: { payload?: string }; mark?: { name?: string } };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.event === 'start' && msg.streamSid) {
      streamSid = msg.streamSid;
      return;
    }
    if (msg.event === 'mark') {
      playbackUntilMark = false;
      return;
    }
    if (msg.event !== 'media' || !msg.media?.payload) return;
    const chunk = Buffer.from(msg.media.payload, 'base64');
    if (responding || playbackUntilMark) {
      interrupt();
      inbound = Buffer.alloc(0);
    }
    inbound = Buffer.concat([inbound, chunk]);
    if (vad) clearTimeout(vad);
    vad = setTimeout(() => {
      vad = null;
      const audio = inbound;
      inbound = Buffer.alloc(0);
      if (audio.length > 0) respond(audio);
    }, VAD_MS);
  });
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
  const port = Number(process.env.PORT ?? 8080);
  startGoodBot({ port })
    .then((bot) => {
      console.log(`good bot on ${bot.url}`);
      console.log(
        `node dist/cli.js ${bot.url} --say hello --barge-in 0.2 --ci --max-first-audio-ms 400 --max-gap-ms 40 --require-barge-in`,
      );
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
