import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ScenarioUsageError } from '../scenario/errors.js';

const require = createRequire(import.meta.url);

export function optionalPackageVersion(name: string): string | undefined {
  try {
    let dir = dirname(require.resolve(name));
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (parsed.name === name) return parsed.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function missingLiveKitMessage(): string {
  return [
    'The LiveKit transport needs optional packages that are not installed.',
    'Install them with:',
    '  npm install @livekit/rtc-node livekit-server-sdk',
  ].join('\n');
}

/** The SDK logs debug lines to stdout, which would break `--json`. */
async function quietLiveKitLog(): Promise<void> {
  if (process.env.CALLSIM_DEBUG) return;
  try {
    const entry = require.resolve('@livekit/rtc-node');
    const mod = (await import(pathToFileURL(join(dirname(entry), 'log.cjs')).href)) as { log?: { level: string } };
    if (mod.log) mod.log.level = 'silent';
  } catch {
    // A future SDK layout can skip this. The call still runs.
  }
}

export interface LiveKitModules {
  rtc: RtcModule;
  sdk: SdkModule;
}

export async function importLiveKit(): Promise<LiveKitModules> {
  try {
    await quietLiveKitLog();
    const rtc = (await import('@livekit/rtc-node')) as RtcModule;
    const sdk = (await import('livekit-server-sdk')) as SdkModule;
    return { rtc, sdk };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot find package') || message.includes('ERR_MODULE_NOT_FOUND')) {
      throw new ScenarioUsageError(missingLiveKitMessage());
    }
    throw new ScenarioUsageError(`${missingLiveKitMessage()}\n${message}`);
  }
}

export interface RtcModule {
  Room: new () => RtcRoom;
  RoomEvent: {
    TrackSubscribed: string;
    ParticipantAttributesChanged: string;
  };
  AudioSource: new (sampleRate: number, channels: number, queueMs?: number) => RtcAudioSource;
  AudioFrame: new (data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) => unknown;
  LocalAudioTrack: { createAudioTrack(name: string, source: RtcAudioSource): unknown };
  AudioStream: new (
    track: unknown,
    options: { sampleRate?: number; numChannels?: number; frameSizeMs?: number },
  ) => AsyncIterable<RtcAudioFrame>;
  TrackPublishOptions: new (init?: { source?: number }) => unknown;
  TrackSource: { SOURCE_MICROPHONE: number };
  TrackKind: { KIND_AUDIO: number };
}

export interface SdkModule {
  AccessToken: new (
    key: string,
    secret: string,
    options?: { identity?: string; attributes?: Record<string, string>; ttl?: string | number },
  ) => RtcToken;
  AgentDispatchClient: new (
    host: string,
    key: string,
    secret: string,
  ) => { createDispatch(room: string, agentName: string, options?: { metadata?: string }): Promise<unknown> };
  RoomServiceClient: new (host: string, key: string, secret: string) => { deleteRoom(room: string): Promise<void> };
}

interface RtcToken {
  kind: string;
  addGrant(grant: Record<string, unknown>): void;
  toJwt(): Promise<string>;
}

export interface RtcRoom {
  connect(url: string, token: string, opts?: { autoSubscribe: boolean; dynacast: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant?: RtcLocalParticipant;
  remoteParticipants: Map<string, RtcRemoteParticipant>;
  registerTextStreamHandler(
    topic: string,
    callback: (reader: RtcTextReader, participant: { identity: string }) => void,
  ): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface RtcAudioSource {
  captureFrame(frame: unknown): Promise<void>;
  waitForPlayout(): Promise<void>;
  clearQueue(): void;
  close(): Promise<void>;
}

export interface RtcAudioFrame {
  data: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
}

interface RtcLocalParticipant {
  identity: string;
  kind: number | string;
  publishTrack(track: unknown, options: unknown): Promise<{ sid?: string }>;
  publishDtmf(code: number, digit: string): Promise<void>;
}

export interface RtcRemoteParticipant {
  identity: string;
  kind: number | string;
  attributes: Record<string, string>;
  trackPublications: Map<string, { sid?: string; kind?: number; track?: unknown }>;
}

interface RtcTextReader {
  readAll(): Promise<string>;
  info: { attributes?: Record<string, string> };
}
