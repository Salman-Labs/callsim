/**
 * Scripted LiveKit participant that stands in for an agent worker.
 *
 * `good` stops speaking when the caller barges in, then answers.
 * `buggy` keeps the utterance going and stays silent after the interruption.
 * Transcripts are published on `lk.transcription` (its own line, and what it
 * "heard") so a scenario can run without an STT key.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { EnergyVad } from '../src/vad.js';

const PUBLISH_RATE = 48_000;
const FRAME_SAMPLES = 480;

export interface ScriptedAgentOptions {
  mode: 'good' | 'buggy';
  url?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface ScriptedAgent {
  stop(): Promise<void>;
}

export async function startScriptedAgent(options: ScriptedAgentOptions): Promise<ScriptedAgent> {
  const url = options.url ?? process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880';
  const apiKey = options.apiKey ?? process.env.LIVEKIT_API_KEY ?? 'devkey';
  const apiSecret = options.apiSecret ?? process.env.LIVEKIT_API_SECRET ?? 'secret';
  const http = httpHost(url);
  const rooms = new RoomServiceClient(http, apiKey, apiSecret);
  const joined = new Set<string>();
  const sessions: AgentSession[] = [];
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const listed = await rooms.listRooms();
      for (const room of listed) {
        if (!room.name.startsWith('callsim-') || joined.has(room.name)) continue;
        joined.add(room.name);
        const session = new AgentSession(options.mode, url, apiKey, apiSecret, room.name);
        sessions.push(session);
        void session.start().catch(() => undefined);
      }
    } catch {
      // The dev server may still be coming up.
    }
  };

  await poll();
  const timer = setInterval(() => void poll(), 150);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all(sessions.map((session) => session.stop()));
    },
  };
}

class AgentSession {
  private readonly room = new Room();
  private readonly source = new AudioSource(PUBLISH_RATE, 1, 200);
  private readonly callerVad = new EnergyVad();
  private chain: Promise<void> = Promise.resolve();
  private playAbort: AbortController | null = null;
  private agentTrackSid: string | undefined;
  private callerTrackSid: string | undefined;
  private greeted = false;
  private callerTurns = 0;
  private interrupted = false;
  private playing = false;
  private dtmfHandled = false;
  private stopped = false;

  constructor(
    private readonly mode: 'good' | 'buggy',
    private readonly url: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly roomName: string,
  ) {}

  async start(): Promise<void> {
    this.room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!participant.identity.startsWith('callsim-caller')) return;
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      this.callerTrackSid = publication.sid;
      void this.watchCaller(track);
    });
    this.room.on(RoomEvent.DtmfReceived, (_code, digit) => {
      if (this.mode !== 'good' || digit !== '1' || this.dtmfHandled) return;
      this.dtmfHandled = true;
      this.enqueue(() => this.speak('Order confirmed', 400, 660));
    });
    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity.startsWith('callsim-caller')) this.enqueue(() => this.greet());
    });

    await this.room.connect(this.url, await this.token(), { autoSubscribe: true, dynacast: false });
    const local = this.room.localParticipant;
    if (!local) return;
    const track = LocalAudioTrack.createAudioTrack('agent-audio', this.source);
    const published = await local.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
    this.agentTrackSid = published.sid;
    await delay(400);
    if (this.stopped) return;
    if (this.findCaller()) this.enqueue(() => this.greet());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.playAbort?.abort();
    this.source.clearQueue();
    await this.room.disconnect().catch(() => undefined);
    await this.source.close().catch(() => undefined);
  }

  private findCaller(): RemoteParticipant | undefined {
    for (const participant of this.room.remoteParticipants.values()) {
      if (participant.identity.startsWith('callsim-caller')) return participant;
    }
    return undefined;
  }

  private async token(): Promise<string> {
    const token = new AccessToken(this.apiKey, this.apiSecret, { identity: 'callsim-fake-agent', ttl: '10m' });
    token.kind = 'agent';
    token.addGrant({
      roomJoin: true,
      room: this.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return token.toJwt();
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task, task);
  }

  private async greet(): Promise<void> {
    if (this.greeted || this.stopped) return;
    this.greeted = true;
    await this.speak('Thanks for calling. What can I get you?', 500, 440);
  }

  private async watchCaller(track: RemoteTrack): Promise<void> {
    const stream = new AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 });
    let at = 0;
    try {
      for await (const frame of stream) {
        const count = frame.samplesPerChannel > 0 ? frame.samplesPerChannel * (frame.channels || 1) : frame.data.length;
        const pcm = frame.data.subarray(0, count);
        const event = this.callerVad.push(pcm, frame.sampleRate || 16_000, at);
        at += (pcm.length / (frame.sampleRate || 16_000)) * 1000;
        if (!event) continue;
        if (event.type === 'start') {
          if (this.playing) {
            this.interrupted = true;
            if (this.mode === 'good') this.playAbort?.abort();
          }
          continue;
        }
        this.enqueue(() => this.afterCallerUtterance());
      }
    } catch {
      // The caller hung up.
    }
  }

  private async afterCallerUtterance(): Promise<void> {
    if (this.stopped) return;
    if (this.interrupted) {
      if (this.mode === 'buggy') return;
      this.interrupted = false;
      await this.sendText('yes', this.callerTrackSid);
      await this.speak('Updated to a margherita.', 500, 520);
      return;
    }
    this.callerTurns += 1;
    if (this.callerTurns !== 1) return;
    await this.sendText('hello', this.callerTrackSid);
    await this.setState('speaking');
    await this.sendText('Sure. Anything else?', this.agentTrackSid);
    const finished = await this.play(tone(2200, 880));
    if (!finished && this.mode === 'good') {
      await this.setState('listening');
      return;
    }
    await this.setState('listening');
  }

  private async speak(text: string, ms: number, hz: number): Promise<void> {
    if (this.stopped) return;
    await this.setState('speaking');
    await this.sendText(text, this.agentTrackSid);
    await this.play(tone(ms, hz));
    await this.setState('listening');
  }

  private async sendText(text: string, trackSid: string | undefined): Promise<void> {
    const local = this.room.localParticipant;
    if (!local || !trackSid) return;
    await local.sendText(text, {
      topic: 'lk.transcription',
      attributes: {
        'lk.transcription_final': 'true',
        'lk.transcribed_track_id': trackSid,
      },
    });
  }

  private async setState(state: 'listening' | 'speaking' | 'thinking'): Promise<void> {
    const local = this.room.localParticipant;
    if (!local) return;
    await local.setAttributes({ 'lk.agent.state': state }).catch(() => undefined);
  }

  private async play(pcm: Int16Array): Promise<boolean> {
    this.playAbort?.abort();
    const controller = new AbortController();
    this.playAbort = controller;
    this.playing = true;
    try {
      for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
        if (controller.signal.aborted || this.stopped) break;
        const slice = pcm.subarray(offset, Math.min(offset + FRAME_SAMPLES, pcm.length));
        const data = new Int16Array(FRAME_SAMPLES);
        data.set(slice);
        await this.source.captureFrame(new AudioFrame(data, PUBLISH_RATE, 1, FRAME_SAMPLES));
      }
      if (controller.signal.aborted || this.stopped) {
        this.source.clearQueue();
        return false;
      }
      const aborted = new Promise<boolean>((resolve) => {
        if (controller.signal.aborted) {
          this.source.clearQueue();
          resolve(true);
          return;
        }
        controller.signal.addEventListener(
          'abort',
          () => {
            this.source.clearQueue();
            resolve(true);
          },
          { once: true },
        );
      });
      const finished = this.source.waitForPlayout().then(() => false);
      return !(await Promise.race([finished, aborted]));
    } finally {
      if (this.playAbort === controller) this.playing = false;
    }
  }
}

function tone(ms: number, hz: number): Int16Array {
  const count = Math.max(1, Math.round((PUBLISH_RATE * ms) / 1000));
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / PUBLISH_RATE) * 8000);
  }
  return pcm;
}

function httpHost(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed.origin;
}

function delay(ms: number): Promise<void> {
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
  const mode = process.argv.includes('--buggy') ? 'buggy' : 'good';
  startScriptedAgent({ mode })
    .then((agent) => {
      console.log(`livekit ${mode} agent waiting for callsim- rooms`);
      const shutdown = (): void => {
        void agent.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
