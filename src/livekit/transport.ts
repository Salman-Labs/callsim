import type { AgentAudioFrame, AgentPresence, AgentVadEvent, CallerAudio, CallerPlayout, TranscriptEvent, Transport, TransportConnectOptions, TransportSnapshot } from '../transport.js';
import { errorText, ScenarioConnectionError, ScenarioUsageError, scrubSecrets } from '../scenario/errors.js';
import { resampleLinear } from '../wav.js';
import { EnergyVad } from '../vad.js';
import { kindName, resolveCallerKind } from './kind.js';
import {
  importLiveKit,
  type LiveKitModules,
  type RtcAudioSource,
  type RtcAudioStream,
  type RtcLocalAudioTrack,
  type RtcParticipantInfo,
  type RtcRemoteParticipant,
  type RtcRoom,
  type RtcTextReader,
} from './load.js';

const PUBLISH_RATE = 48_000;
const FRAME_SAMPLES = 480;

/**
 * LiveKit room adapter. `@livekit/rtc-node` and `livekit-server-sdk` are
 * optional peer dependencies, loaded with `import()` on connect.
 */
export function createLiveKitTransport(): Transport {
  return new LiveKitTransport();
}

class LiveKitTransport implements Transport {
  readonly name = 'livekit';
  private modules: LiveKitModules | undefined;
  private room: RtcRoom | undefined;
  private source: RtcAudioSource | undefined;
  private origin = 0;
  private roomName: string | undefined;
  private httpUrl = '';
  private apiPrefix = '';
  private wsUrl = '';
  private apiKey = '';
  private apiSecret = '';
  private attributes: Record<string, string> = {};
  private requestedKind: 'sip' | 'standard' = 'standard';
  private callerTrackSid: string | undefined;
  private localTrack: RtcLocalAudioTrack | undefined;
  private agentTrackSid: string | undefined;
  private agentIdentity: string | undefined;
  private agentJoinedMs: number | undefined;
  private state: string | null = null;
  private readonly subscribed = new Set<string>();
  private readonly warningsList: string[] = [];
  private readonly audioStreams = new Set<RtcAudioStream>();
  private readonly agentTracks: RtcLocalAudioTrack[] = [];
  private readonly readers = new Set<RtcTextReader>();
  private readonly waiters: { timer: ReturnType<typeof setTimeout>; resolve: () => void }[] = [];
  private hungUp = false;
  private readonly vad = new EnergyVad();
  private readonly audioListeners = new Set<(frame: AgentAudioFrame) => void>();
  private readonly vadListeners = new Set<(event: AgentVadEvent) => void>();
  private readonly saidListeners = new Set<(event: TranscriptEvent) => void>();
  private readonly heardListeners = new Set<(event: TranscriptEvent) => void>();
  private onEvent: TransportConnectOptions['onEvent'];

  async connect(options: TransportConnectOptions): Promise<void> {
    if (this.room) throw new ScenarioUsageError('LiveKit transport is already connected');
    this.origin = performance.now();
    this.onEvent = options.onEvent;
    const config = options.config;
    this.wsUrl = stringField(config.url) || process.env.LIVEKIT_URL || '';
    if (!this.wsUrl) throw new ScenarioUsageError('LIVEKIT_URL is not set. Set it in the environment or as livekit.url.');
    this.apiKey = process.env.LIVEKIT_API_KEY || '';
    this.apiSecret = process.env.LIVEKIT_API_SECRET || '';
    if (!this.apiKey) throw new ScenarioUsageError('LIVEKIT_API_KEY is not set');
    if (!this.apiSecret) throw new ScenarioUsageError('LIVEKIT_API_SECRET is not set');
    this.httpUrl = httpHost(this.wsUrl);
    this.apiPrefix = pathPrefix(this.wsUrl);
    this.roomName = roomName(options.label, options.runId);
    this.attributes = callerAttributes(config);
    this.requestedKind = callerKind(config);
    this.modules = await importLiveKit();

    const agentName = stringField(config.agent_name);
    if (agentName) await this.dispatch(agentName, options.userdata);

    let connected: RtcRoom | undefined;
    const outcome = await resolveCallerKind(this.requestedKind, async (kind) => {
      await this.closeRoom();
      const modules = this.modules;
      if (!modules || !this.roomName) throw new ScenarioConnectionError('LiveKit modules are not loaded', 'connect_failed');
      const room = new modules.rtc.Room();
      this.room = room;
      connected = room;
      this.wire(room);
      const jwt = await this.mintToken(kind);
      try {
        await room.connect(this.wsUrl, jwt, { autoSubscribe: true, dynacast: false });
      } catch (err) {
        await this.closeRoom();
        connected = undefined;
        throw new ScenarioConnectionError(
          `Could not connect to LiveKit at ${safeUrl(this.wsUrl)}: ${scrubSecrets(errorText(err))}`,
          'connect_failed',
        );
      }
      return { observedKind: kindName(room.localParticipant?.kind) };
    });
    if (outcome.warning) this.warningsList.push(outcome.warning);

    const room = connected ?? this.room;
    const modules = this.modules;
    const local = room?.localParticipant;
    if (!room || !modules || !local) {
      throw new ScenarioConnectionError('LiveKit connect did not create a local participant', 'connect_failed');
    }
    this.source = new modules.rtc.AudioSource(PUBLISH_RATE, 1, 5_000);
    const track = modules.rtc.LocalAudioTrack.createAudioTrack('callsim-caller', this.source);
    this.localTrack = track;
    const published = await local.publishTrack(
      track,
      new modules.rtc.TrackPublishOptions({ source: modules.rtc.TrackSource.SOURCE_MICROPHONE }),
    );
    this.callerTrackSid = published.sid;
    this.emit({
      t: this.now(),
      type: 'caller',
      identity: local.identity,
      kind: outcome.kind,
      requestedKind: this.requestedKind,
    });
    this.scanParticipants();
  }

  async waitForAgent(timeoutMs: number): Promise<AgentPresence> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.scanParticipants();
      if (this.agentIdentity && (this.agentTrackSid || this.hasAgentAudioPublication())) {
        return { identity: this.agentIdentity, joinedMs: this.agentJoinedMs ?? this.now() };
      }
      await this.delay(50);
    }
    throw new ScenarioConnectionError(
      `agent_not_joined: no participant with kind agent published audio within ${timeoutMs} ms. Check that a worker is running, and agent_name if you use explicit dispatch.`,
      'agent_not_joined',
    );
  }

  async playCallerAudio(audio: CallerAudio): Promise<CallerPlayout> {
    const source = this.source;
    const modules = this.modules;
    if (!source || !modules) throw new ScenarioConnectionError('caller is not connected', 'not_connected');
    const pcm = resampleLinear(audio.pcm, audio.sampleRate, PUBLISH_RATE);
    const audioMs = audio.sampleRate > 0 ? (audio.pcm.length / audio.sampleRate) * 1000 : 0;
    const startedAtMs = this.now();
    for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
      const slice = pcm.subarray(offset, Math.min(offset + FRAME_SAMPLES, pcm.length));
      const data = new Int16Array(FRAME_SAMPLES);
      data.set(slice);
      await source.captureFrame(new modules.rtc.AudioFrame(data, PUBLISH_RATE, 1, FRAME_SAMPLES));
    }
    if (pcm.length > 0) await source.waitForPlayout();
    return { audioMs, startedAtMs, endedAtMs: this.now() };
  }

  async sendDtmf(digits: string): Promise<void> {
    const local = this.room?.localParticipant;
    if (!local) throw new ScenarioConnectionError('caller is not connected', 'not_connected');
    for (const digit of digits) {
      await local.publishDtmf(dtmfCode(digit), digit);
    }
  }

  onAgentAudio(listener: (frame: AgentAudioFrame) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  onAgentVad(listener: (event: AgentVadEvent) => void): () => void {
    this.vadListeners.add(listener);
    return () => this.vadListeners.delete(listener);
  }

  onAgentTranscript(listener: (event: TranscriptEvent) => void): () => void {
    this.saidListeners.add(listener);
    return () => this.saidListeners.delete(listener);
  }

  onCallerHeard(listener: (event: TranscriptEvent) => void): () => void {
    this.heardListeners.add(listener);
    return () => this.heardListeners.delete(listener);
  }

  agentState(): string | null {
    return this.state;
  }

  now(): number {
    if (!this.origin) return 0;
    return Math.max(0, Math.round(performance.now() - this.origin));
  }

  roomId(): string | undefined {
    return this.roomName;
  }

  warnings(): readonly string[] {
    return this.warningsList;
  }

  hasNativeTranscript(): boolean {
    return true;
  }

  snapshot(): TransportSnapshot {
    return {};
  }

  async hangup(): Promise<void> {
    if (this.hungUp) return;
    this.hungUp = true;
    const name = this.roomName;
    const modules = this.modules;
    await this.closeRoom();
    await this.clearServerRoom(modules, name);
  }

  private async dispatch(agentName: string, userdata: unknown): Promise<void> {
    const modules = this.modules;
    if (!modules || !this.roomName) return;
    try {
      const client = withPathPrefix(new modules.sdk.AgentDispatchClient(this.httpUrl, this.apiKey, this.apiSecret), this.apiPrefix);
      await client.createDispatch(this.roomName, agentName, { metadata: JSON.stringify(userdata ?? {}) });
      this.emit({ t: this.now(), type: 'dispatch', agentName });
    } catch (err) {
      throw new ScenarioConnectionError(
        `agent dispatch failed for ${agentName} at ${safeUrl(this.httpUrl + this.apiPrefix)}: ${scrubSecrets(errorText(err))}`,
        'dispatch_failed',
      );
    }
  }

  private async mintToken(kind: 'sip' | 'standard'): Promise<string> {
    const modules = this.modules;
    if (!modules || !this.roomName) throw new ScenarioConnectionError('LiveKit modules are not loaded', 'connect_failed');
    const token = new modules.sdk.AccessToken(this.apiKey, this.apiSecret, {
      identity: 'callsim-caller',
      ttl: '10m',
      ...(Object.keys(this.attributes).length > 0 ? { attributes: this.attributes } : {}),
    });
    if (kind === 'sip') token.kind = 'sip';
    token.addGrant({
      roomJoin: true,
      room: this.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return token.toJwt();
  }

  private wire(room: RtcRoom): void {
    const modules = this.modules;
    if (!modules) return;
    room.registerTextStreamHandler('lk.transcription', (reader, participant) => {
      void this.consumeTranscript(reader, participant.identity);
    });
    room.on(modules.rtc.RoomEvent.TrackSubscribed, ((track: unknown, publication: unknown, participant: unknown) => {
      const remote = participant as RtcRemoteParticipant;
      const pub = publication as { sid?: string; kind?: number };
      const media = track as { kind?: number };
      if (kindName(remote.kind) !== 'agent') return;
      if (media.kind !== modules.rtc.TrackKind.KIND_AUDIO && pub.kind !== modules.rtc.TrackKind.KIND_AUDIO) return;
      this.noteAgent(remote);
      this.attachAgentAudio(pub.sid, track);
    }) as (...args: unknown[]) => void);
    room.on(modules.rtc.RoomEvent.ParticipantAttributesChanged, ((changed: unknown, participant: unknown) => {
      const remote = participant as RtcRemoteParticipant;
      if (remote.identity !== this.agentIdentity) return;
      const next = remote.attributes?.['lk.agent.state'] ?? (changed as Record<string, string>)['lk.agent.state'];
      if (typeof next === 'string') this.state = next;
    }) as (...args: unknown[]) => void);
  }

  private scanParticipants(): void {
    const room = this.room;
    const modules = this.modules;
    if (!room || !modules) return;
    for (const participant of room.remoteParticipants.values()) {
      if (kindName(participant.kind) !== 'agent') continue;
      this.noteAgent(participant);
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === modules.rtc.TrackKind.KIND_AUDIO && publication.track) {
          this.attachAgentAudio(publication.sid, publication.track);
        }
      }
    }
  }

  private hasAgentAudioPublication(): boolean {
    const room = this.room;
    const modules = this.modules;
    if (!room || !modules || !this.agentIdentity) return false;
    for (const participant of room.remoteParticipants.values()) {
      if (participant.identity !== this.agentIdentity) continue;
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind === modules.rtc.TrackKind.KIND_AUDIO) return true;
      }
    }
    return false;
  }

  private noteAgent(participant: RtcRemoteParticipant): void {
    if (!this.agentIdentity) this.agentJoinedMs = this.now();
    this.agentIdentity = participant.identity;
    const state = participant.attributes?.['lk.agent.state'];
    if (state) this.state = state;
  }

  private attachAgentAudio(sid: string | undefined, track: unknown): void {
    const key = sid || 'agent-audio';
    if (this.subscribed.has(key)) return;
    this.subscribed.add(key);
    if (sid) this.agentTrackSid = sid;
    const media = track as RtcLocalAudioTrack;
    this.agentTracks.push(media);
    void this.readAgentAudio(media);
  }

  private async readAgentAudio(track: RtcLocalAudioTrack): Promise<void> {
    const modules = this.modules;
    if (!modules) return;
    const stream = new modules.rtc.AudioStream(track, { sampleRate: 16_000, numChannels: 1, frameSizeMs: 20 });
    this.audioStreams.add(stream);
    try {
      for await (const frame of stream) {
        const channels = frame.channels || 1;
        const count = frame.samplesPerChannel > 0 ? frame.samplesPerChannel * channels : frame.data.length;
        const pcm = frame.data.subarray(0, count);
        const atMs = this.now();
        const audio = { pcm, sampleRate: frame.sampleRate || 16_000, atMs };
        for (const listener of this.audioListeners) listener(audio);
        const event = this.vad.push(pcm, audio.sampleRate, atMs);
        if (event) for (const listener of this.vadListeners) listener(event);
      }
    } catch {
      // Disconnect ends the stream.
    } finally {
      this.audioStreams.delete(stream);
    }
  }

  /**
   * LiveKit Agents streams the agent's reply into one text stream, word by word
   * as it plays, and opens it with `lk.transcription_final: "false"`. Closing
   * the stream is what ends the segment; the attribute is never updated. So
   * agent text is emitted as it arrives (not final), and once more as final
   * when the stream closes. The caller's interim transcripts are one stream
   * each, so for them the attribute is the answer.
   */
  private async consumeTranscript(reader: RtcTextReader, sender: string): Promise<void> {
    this.readers.add(reader);
    const attributes = reader.info.attributes ?? {};
    const segmentId = attributes['lk.segment_id'];
    const role = this.transcriptRole(attributes['lk.transcribed_track_id'], sender);
    const listeners = role === 'caller' ? this.heardListeners : this.saidListeners;
    const send = (text: string, final: boolean): void => {
      const event: TranscriptEvent = { text, final, atMs: this.now(), ...(segmentId ? { segmentId } : {}) };
      for (const listener of listeners) listener(event);
    };
    let text = '';
    try {
      for await (const chunk of reader) {
        text += chunk;
        if (role === 'agent') send(text, false);
      }
    } catch {
      return;
    } finally {
      this.readers.delete(reader);
      await reader.close().catch(() => undefined);
    }
    send(text, role === 'agent' || attributes['lk.transcription_final'] !== 'false');
    this.emit({ t: this.now(), type: 'transcription', role, text });
  }

  private transcriptRole(trackId: string | undefined, sender: string): 'agent' | 'caller' {
    if (trackId && this.callerTrackSid && trackId === this.callerTrackSid) return 'caller';
    if (trackId && this.agentTrackSid && trackId === this.agentTrackSid) return 'agent';
    if (this.agentIdentity && sender === this.agentIdentity && !trackId) return 'agent';
    return 'agent';
  }

  private async closeRoom(): Promise<void> {
    const room = this.room;
    const source = this.source;
    const localTrack = this.localTrack;
    this.clearTimers();
    await this.closeReaders();
    this.stopAgentAudio();
    await this.unpublishLocal(room);
    this.localTrack = undefined;
    this.callerTrackSid = undefined;
    if (localTrack) await localTrack.close(false).catch(() => undefined);
    this.source = undefined;
    if (source) {
      try {
        source.clearQueue();
      } catch {
        // The source may already be closed.
      }
      await source.close().catch(() => undefined);
    }
    try {
      room?.unregisterTextStreamHandler('lk.transcription');
    } catch {
      // No handler was registered.
    }
    this.room = undefined;
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => undefined);
    }
    await this.closeAgentTracks();
  }

  private async clearServerRoom(modules: LiveKitModules | undefined, name: string | undefined): Promise<void> {
    if (!name || !modules || !this.httpUrl || !this.apiKey || !this.apiSecret) return;
    const rooms = withPathPrefix(new modules.sdk.RoomServiceClient(this.httpUrl, this.apiKey, this.apiSecret), this.apiPrefix);
    let participants: RtcParticipantInfo[] = [];
    try {
      participants = await rooms.listParticipants(name);
    } catch {
      participants = [];
    }
    for (const participant of participants) {
      const identity = participant.identity;
      if (!identity) continue;
      for (const track of participant.tracks ?? []) {
        if (!track.sid) continue;
        await rooms.mutePublishedTrack(name, identity, track.sid, true).catch(() => undefined);
      }
      await rooms.removeParticipant(name, identity).catch(() => undefined);
    }
    try {
      await rooms.deleteRoom(name);
    } catch {
      // The room is already gone when the last participant left.
    }
  }

  private async closeReaders(): Promise<void> {
    const readers = [...this.readers];
    this.readers.clear();
    await Promise.all(readers.map((reader) => reader.close().catch(() => undefined)));
  }

  private stopAgentAudio(): void {
    for (const track of this.agentTracks) {
      try {
        track.closeAudioStreams?.();
      } catch {
        // The stream is already closed.
      }
    }
    for (const stream of this.audioStreams) {
      void stream.cancel().catch(() => undefined);
    }
  }

  private async closeAgentTracks(): Promise<void> {
    const tracks = this.agentTracks.splice(0);
    this.audioStreams.clear();
    await Promise.all(tracks.map((track) => track.close?.().catch(() => undefined) ?? Promise.resolve()));
  }

  private async unpublishLocal(room: RtcRoom | undefined): Promise<void> {
    const local = room?.localParticipant;
    if (!local) return;
    const sids = new Set<string>();
    if (this.callerTrackSid) sids.add(this.callerTrackSid);
    for (const publication of local.trackPublications.values()) {
      if (publication.sid) sids.add(publication.sid);
    }
    for (const sid of sids) {
      await local.unpublishTrack(sid, true).catch(() => undefined);
    }
  }

  private clearTimers(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiter = {
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        }, ms),
        resolve,
      };
      this.waiters.push(waiter);
    });
  }

  private emit(event: { t: number; type: string; [key: string]: unknown }): void {
    this.onEvent?.(event);
  }
}

function callerKind(config: Record<string, unknown>): 'sip' | 'standard' {
  const caller = config.caller;
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)) return 'standard';
  const kind = (caller as { kind?: unknown }).kind;
  return kind === 'sip' ? 'sip' : 'standard';
}

function callerAttributes(config: Record<string, unknown>): Record<string, string> {
  const caller = config.caller;
  if (!caller || typeof caller !== 'object' || Array.isArray(caller)) return {};
  const attributes = (caller as { attributes?: unknown }).attributes;
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function roomName(label: string, runId: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scenario';
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  return `callsim-${slug}-${suffix}`;
}

export function httpHost(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return parsed.origin;
}

/** `wss://host/livekit/` -> `/livekit`, for a server behind a path-routing proxy. */
export function pathPrefix(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, '');
}

/**
 * livekit-server-sdk resolves `/twirp/...` against the host, which drops a path
 * prefix, and its clients do not pass a `prefix` option through. Put the path
 * in front of the client's RPC prefix so API calls go where the room does.
 */
export function withPathPrefix<T>(client: T, prefix: string): T {
  // ponytail: writes TwirpRpc.prefix (livekit-server-sdk 2.19). If the SDK renames it, a prefixed URL falls back to the bare host.
  const rpc = (client as { rpc?: { prefix?: unknown } }).rpc;
  if (prefix && rpc && typeof rpc.prefix === 'string' && !rpc.prefix.startsWith(prefix)) rpc.prefix = `${prefix}${rpc.prefix}`;
  return client;
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '(invalid url)';
  }
}

function dtmfCode(digit: string): number {
  if (digit === '*') return 10;
  if (digit === '#') return 11;
  const code = Number(digit);
  if (!Number.isInteger(code) || code < 0 || code > 9) {
    throw new ScenarioUsageError(`DTMF digit ${digit} is not 0-9, *, or #`);
  }
  return code;
}

