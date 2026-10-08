import { randomBytes } from 'node:crypto';
import { FRAME_BYTES } from './constants.js';
import type { FormatProblem } from './types.js';

/**
 * Bidirectional Media Streams messages.
 * https://www.twilio.com/docs/voice/media-streams/websocket-messages
 *
 * Twilio sends connected, start, media, dtmf, mark, and stop.
 * The bot sends media, mark, and clear. `sequenceNumber` starts at "1"
 * on start and increments for every later Twilio message. connected has none.
 * On clear, buffered audio is dropped and any marks still queued are echoed
 * immediately so the bot can tell which audio will not be played.
 */

export function createSid(prefix: 'AC' | 'CA' | 'MZ'): string {
  return prefix + randomBytes(16).toString('hex');
}

export interface ConnectedMessage {
  event: 'connected';
  protocol: 'Call';
  version: '1.0.0';
}

export interface StartMessage {
  event: 'start';
  sequenceNumber: string;
  streamSid: string;
  start: {
    accountSid: string;
    streamSid: string;
    callSid: string;
    tracks: ['inbound'];
    mediaFormat: {
      encoding: 'audio/x-mulaw';
      sampleRate: 8000;
      channels: 1;
    };
    customParameters: Record<string, string>;
  };
}

export interface MediaMessage {
  event: 'media';
  sequenceNumber: string;
  streamSid: string;
  media: {
    track: 'inbound';
    chunk: string;
    timestamp: string;
    payload: string;
  };
}

export interface DtmfMessage {
  event: 'dtmf';
  streamSid: string;
  sequenceNumber: string;
  dtmf: {
    track: 'inbound_track';
    digit: string;
  };
}

export interface StopMessage {
  event: 'stop';
  sequenceNumber: string;
  streamSid: string;
  stop: {
    accountSid: string;
    callSid: string;
  };
}

export interface MarkEchoMessage {
  event: 'mark';
  sequenceNumber: string;
  streamSid: string;
  mark: { name: string };
}

export function connectedMessage(): ConnectedMessage {
  return { event: 'connected', protocol: 'Call', version: '1.0.0' };
}

export function startMessage(args: {
  sequenceNumber: string;
  streamSid: string;
  callSid: string;
  accountSid: string;
  customParameters: Record<string, string>;
}): StartMessage {
  return {
    event: 'start',
    sequenceNumber: args.sequenceNumber,
    streamSid: args.streamSid,
    start: {
      accountSid: args.accountSid,
      streamSid: args.streamSid,
      callSid: args.callSid,
      tracks: ['inbound'],
      mediaFormat: {
        encoding: 'audio/x-mulaw',
        sampleRate: 8000,
        channels: 1,
      },
      customParameters: args.customParameters,
    },
  };
}

export type ParsedBotMessage =
  | { kind: 'media'; streamSid?: string; payload: unknown; encoding?: string }
  | { kind: 'mark'; streamSid?: string; name: string }
  | { kind: 'clear'; streamSid?: string }
  | { kind: 'ignored'; event: string }
  | { kind: 'invalid'; detail: string };

export function parseBotMessage(value: unknown): ParsedBotMessage {
  if (!value || typeof value !== 'object') return { kind: 'invalid', detail: 'message is not a JSON object' };
  const msg = value as Record<string, unknown>;
  const streamSid = typeof msg.streamSid === 'string' ? msg.streamSid : undefined;
  if (msg.event === 'media') {
    const media = msg.media;
    if (!media || typeof media !== 'object') return { kind: 'invalid', detail: 'media message is missing media' };
    const body = media as Record<string, unknown>;
    const encoding = body.encoding ?? body.contentType;
    return {
      kind: 'media',
      streamSid,
      payload: body.payload,
      ...(typeof encoding === 'string' ? { encoding } : {}),
    };
  }
  if (msg.event === 'mark') {
    const mark = msg.mark;
    if (!mark || typeof mark !== 'object' || typeof (mark as Record<string, unknown>).name !== 'string') {
      return { kind: 'invalid', detail: 'mark message is missing mark.name' };
    }
    return { kind: 'mark', streamSid, name: (mark as { name: string }).name };
  }
  if (msg.event === 'clear') return { kind: 'clear', streamSid };
  if (typeof msg.event === 'string') return { kind: 'ignored', event: msg.event };
  return { kind: 'invalid', detail: 'message is missing event' };
}

export function inspectMediaPayload(payload: unknown): { bytes: Buffer | null; problems: FormatProblem[] } {
  if (typeof payload !== 'string') {
    return { bytes: null, problems: [{ kind: 'invalid-base64', detail: 'media.payload is not a string' }] };
  }
  if (payload.length === 0) {
    return { bytes: null, problems: [{ kind: 'empty-payload', detail: 'media.payload is empty' }] };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    return { bytes: null, problems: [{ kind: 'invalid-base64', detail: 'media.payload is not base64' }] };
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) {
    return { bytes: null, problems: [{ kind: 'empty-payload', detail: 'media.payload decoded to 0 bytes' }] };
  }
  if (hasContainerHeader(bytes)) {
    return {
      bytes: null,
      problems: [
        {
          kind: 'non-mulaw',
          detail: 'payload starts with an audio-file header; Media Streams expects raw audio/x-mulaw',
        },
      ],
    };
  }
  const problems: FormatProblem[] = [];
  if (bytes.length % FRAME_BYTES !== 0) {
    problems.push({
      kind: 'unexpected-frame-size',
      detail: `payload is ${bytes.length} bytes; expected a multiple of ${FRAME_BYTES} (20 ms of 8 kHz μ-law)`,
    });
  }
  return { bytes, problems };
}

function hasContainerHeader(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const head = bytes.toString('ascii', 0, 4);
  return head === 'RIFF' || head === '.snd' || head === 'OggS' || head === 'fLaC' || bytes.toString('ascii', 0, 3) === 'ID3';
}

export function normalizeWsUrl(url: string): string {
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  if (url.startsWith('wss://') || url.startsWith('ws://')) return url;
  throw new Error(`Expected a ws:// or wss:// URL, got ${url}`);
}
