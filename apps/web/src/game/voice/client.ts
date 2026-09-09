import {
  OfficeState,
  VOICE_BITRATE,
  VOICE_FLAG_DTX,
  VOICE_FRAME_SAMPLES,
  VOICE_HEADER_BYTES,
  VOICE_PATH,
  VOICE_SAMPLE_RATE,
  packVoiceHeader,
  parseVoiceHeader,
  type VoicePeer,
  type VoiceServerMessage,
  type VoiceUiState,
} from '@quintal/shared';
import type { Room } from 'colyseus.js';

import {
  JitterScheduler,
  SpeakingMeter,
  gainFor,
  isSilence,
  levelDbov,
  shouldBeOpen,
} from './rules';
import { voiceSupport } from './support';

/**
 * The voice client: the office's proximity voice, from this seat.
 *
 * One plain object outside React and outside Phaser, owned by the game
 * session and rebuilt with it, so it follows a reconnect the way the rest
 * of the session does. It does four things and nothing else:
 *
 * - **Decides when to exist.** Watches the room's players ten times a
 *   second; opens the relay socket when a second *human* is within earshot
 *   and a little more, closes it when they are not. Alone with agents there
 *   is no socket and no microphone, which is most of what the office does.
 * - **Captures.** The microphone → 20 ms frames on the audio thread →
 *   WebCodecs `AudioEncoder` opus → header → socket. Only while unmuted or
 *   while push-to-talk is held; muted means no frames at all.
 * - **Plays.** Frames → per-peer `AudioDecoder` → a jitter-buffered cadence
 *   → a per-peer gain that follows tile distance → one output. Distance
 *   shapes volume only; whether a frame arrived was the server's decision.
 * - **Tells.** Who is speaking (from frames, never from level), the mic,
 *   the socket, the devices, the last error — to the UI and to the scene.
 *
 * The codec is WebCodecs and nothing else. A browser without it is told so
 * once and keeps text.
 */

export interface VoiceClientOptions {
  origin: string;
  token: string;
  sessionId: string;
  workspaceId: string;
  room: Room<OfficeState>;
  /** Pixels per tile, once the map is known. */
  tileSize: () => number;
  onState: (state: VoiceUiState) => void;
  /** A ring to light or put out, on the avatar of this session. */
  onSpeaking: (sessionId: string, speaking: boolean) => void;
}

interface Peer {
  sessionId: string;
  name: string;
  decoder: AudioDecoder | null;
  gain: GainNode | null;
  jitter: JitterScheduler;
}

/** Until the office says otherwise. Matches the settings default. */
const DEFAULT_RADIUS_TILES = 12;
/** How often positions are looked at for the socket and the gains. */
const WATCH_MS = 100;
/** After a failed or dropped socket, wait this long before another try. */
const RETRY_MS = 1_500;
/** Silence frames sent before the rest are simply not sent. */
const SILENCE_FRAMES_SENT = 5;
/** How long after a non-silence frame of ours we count ourselves as speaking. */
const SELF_SPEAKING_MS = 400;
/** Where the capture worklet lives, served as a plain file. */
const WORKLET_URL = '/voice/capture-worklet.js';

type OpusEncoderConfig = AudioEncoderConfig & {
  opus?: { application?: 'voip' | 'audio'; usedtx?: boolean; frameDuration?: number };
};

export class VoiceClient {
  readonly #opts: VoiceClientOptions;
  #state: VoiceUiState;
  #lastEmitted = '';

  #radius = DEFAULT_RADIUS_TILES;
  #muted = true;
  #talking = false;
  #stopped = false;

  #ws: WebSocket | null = null;
  #wantOpen = false;
  #retryAt = 0;
  #watch: ReturnType<typeof setInterval> | null = null;

  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #workletLoaded = false;
  #mic: MediaStream | null = null;
  #micSource: MediaStreamAudioSourceNode | null = null;
  #capture: AudioWorkletNode | null = null;
  /** Keeps the worklet in the graph without letting the mic be heard. */
  #sink: GainNode | null = null;
  #encoder: AudioEncoder | null = null;
  #micPending: Promise<void> | null = null;
  #unlock: (() => void) | null = null;

  readonly #peersByIndex = new Map<number, Peer>();
  readonly #peersById = new Map<string, Peer>();
  readonly #meter = new SpeakingMeter();
  #lit = new Set<string>();
  #selfSpeakingUntil = 0;

  #seq = 0;
  #sampleClock = 0;
  #silenceRun = 0;
  /** Level and flags for frames handed to the encoder, in order; outputs arrive in order. */
  readonly #pendingMeta: Array<{ level: number; flags: number; timestamp: number }> = [];

  constructor(opts: VoiceClientOptions) {
    this.#opts = opts;
    this.#state = {
      support: voiceSupport() === 'ok' ? 'ok' : 'unsupported',
      socket: 'closed',
      mic: 'off',
      talking: false,
      speaking: [],
      peers: 0,
      devices: [],
      deviceId: null,
      error: null,
    };
  }

  get state(): VoiceUiState {
    return this.#state;
  }

  // --- lifecycle -------------------------------------------------------------

  start(): void {
    this.#emit();
    if (this.#state.support !== 'ok') return;
    this.#watch = setInterval(() => this.#tick(), WATCH_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    this.#closeSocket();
    this.#releaseMic();
    for (const peer of this.#peersById.values()) this.#dropPeer(peer);
    for (const id of this.#lit) this.#opts.onSpeaking(id, false);
    this.#lit.clear();
    this.#unlock?.();
    void this.#ctx?.close();
    this.#ctx = null;
    this.#master = null;
  }

  /** The office said how far a voice carries here. */
  setRadius(tiles: number): void {
    if (Number.isFinite(tiles) && tiles > 0) this.#radius = tiles;
  }

  // --- what the person controls ------------------------------------------------

  setMuted(muted: boolean): void {
    this.#muted = muted;
    if (!muted) void this.#ensureMic();
    this.#emit();
  }

  toggleMute(): void {
    this.setMuted(!this.#muted);
  }

  /** Push-to-talk: held means sending, whatever the mute switch says. */
  setTalking(down: boolean): void {
    if (this.#talking === down) return;
    this.#talking = down;
    if (down) void this.#ensureMic();
    this.#emit();
  }

  async setDevice(deviceId: string): Promise<void> {
    this.#state = { ...this.#state, deviceId };
    if (this.#mic) {
      this.#releaseMic();
      await this.#ensureMic();
    }
    this.#emit();
  }

  // --- the watcher --------------------------------------------------------------

  #tick(): void {
    if (this.#stopped) return;
    const players = this.#opts.room.state.players;
    const me = players.get(this.#opts.sessionId);
    const tile = this.#opts.tileSize() || 32;

    let nearest: number | null = null;
    if (me) {
      for (const [sessionId, player] of players) {
        if (sessionId === this.#opts.sessionId || player.kind !== 'human') continue;
        const distance = Math.hypot(player.x - me.x, player.y - me.y) / tile;
        if (nearest === null || distance < nearest) nearest = distance;
        // Volume by distance, for anybody we are already hearing.
        const peer = this.#peersById.get(sessionId);
        if (peer?.gain && this.#ctx) {
          peer.gain.gain.setTargetAtTime(gainFor(distance, this.#radius), this.#ctx.currentTime, 0.05);
        }
      }
    }

    const want = shouldBeOpen(this.#wantOpen, nearest, this.#radius);
    if (want !== this.#wantOpen) {
      this.#wantOpen = want;
      if (want) this.#openSocket();
      else this.#closeSocket();
    } else if (want && !this.#ws && Date.now() >= this.#retryAt) {
      this.#openSocket();
    }

    // Rings: peers by their frames, ourselves by our own.
    const now = performance.now();
    const speaking = new Set(this.#meter.speaking(now));
    if (now < this.#selfSpeakingUntil) speaking.add(this.#opts.sessionId);
    let changed = false;
    for (const id of speaking) {
      if (!this.#lit.has(id)) {
        this.#opts.onSpeaking(id, true);
        changed = true;
      }
    }
    for (const id of this.#lit) {
      if (!speaking.has(id)) {
        this.#opts.onSpeaking(id, false);
        changed = true;
      }
    }
    this.#lit = speaking;
    if (changed) this.#emit();
  }

  // --- the socket ----------------------------------------------------------------

  #openSocket(): void {
    if (this.#ws || this.#stopped) return;
    const url = `${this.#opts.origin.replace(/^http/, 'ws')}${VOICE_PATH}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    this.#state = { ...this.#state, socket: 'connecting', error: null };
    this.#emit();

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: this.#opts.token,
          sessionId: this.#opts.sessionId,
          workspaceId: this.#opts.workspaceId,
        }),
      );
    };
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let message: VoiceServerMessage | null = null;
        try {
          message = JSON.parse(event.data) as VoiceServerMessage;
        } catch {
          // Not ours to crash on: the relay's control messages are JSON, and
          // anything else is ignored the way a bad frame is.
        }
        if (message && typeof message === 'object' && 'type' in message) this.#control(message);
      } else if (event.data instanceof ArrayBuffer) {
        this.#frame(new Uint8Array(event.data));
      }
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#retryAt = Date.now() + RETRY_MS;
      for (const peer of [...this.#peersById.values()]) this.#dropPeer(peer);
      this.#state = {
        ...this.#state,
        socket: 'closed',
        peers: 0,
        error: event.code >= 4400 ? `Voice closed: ${event.reason || event.code}` : this.#state.error,
      };
      this.#emit();
    };
    ws.onerror = () => {
      // `onclose` follows and says what it can.
    };
  }

  #closeSocket(): void {
    const ws = this.#ws;
    this.#ws = null;
    if (ws) ws.close(1000, 'leaving earshot');
    for (const peer of [...this.#peersById.values()]) this.#dropPeer(peer);
    // Nobody to talk to means no microphone either: the browser's "mic in
    // use" indicator should be as honest as the wire. The mute switch is
    // remembered; the next socket re-opens the mic if it is set to send.
    this.#releaseMic();
    this.#state = { ...this.#state, socket: 'closed', peers: 0 };
    this.#emit();
  }

  #control(message: VoiceServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.#state = { ...this.#state, socket: 'open', error: null };
        void this.#ensureContext();
        // Set to send — unmuted, or the key already held — so the mic comes
        // back with the socket, without asking permission again.
        if (!this.#muted || this.#talking) void this.#ensureMic();
        this.#emit();
        return;
      case 'peers':
        for (const joined of message.joined) this.#addPeer(joined);
        for (const sessionId of message.left) {
          const peer = this.#peersById.get(sessionId);
          if (peer) this.#dropPeer(peer);
        }
        this.#state = { ...this.#state, peers: this.#peersById.size };
        this.#emit();
        return;
      case 'error':
        this.#state = { ...this.#state, error: message.message };
        this.#emit();
        return;
    }
  }

  #addPeer(joined: VoicePeer): void {
    const existing = this.#peersById.get(joined.sessionId);
    if (existing) this.#dropPeer(existing);
    const peer: Peer = {
      sessionId: joined.sessionId,
      name: joined.name,
      decoder: null,
      gain: null,
      jitter: new JitterScheduler(),
    };
    this.#peersByIndex.set(joined.peerIndex, peer);
    this.#peersById.set(joined.sessionId, peer);
  }

  #dropPeer(peer: Peer): void {
    for (const [index, candidate] of this.#peersByIndex) {
      if (candidate === peer) this.#peersByIndex.delete(index);
    }
    this.#peersById.delete(peer.sessionId);
    this.#meter.forget(peer.sessionId);
    try {
      peer.decoder?.close();
    } catch {
      // Already closed.
    }
    peer.gain?.disconnect();
  }

  // --- playing what arrives ------------------------------------------------------

  #frame(bytes: Uint8Array): void {
    if (bytes.byteLength < 1 + VOICE_HEADER_BYTES) return;
    const peer = this.#peersByIndex.get(bytes[0]!);
    const frame = bytes.subarray(1);
    const header = parseVoiceHeader(frame);
    if (!peer || !header) return;

    const silence = (header.flags & VOICE_FLAG_DTX) !== 0;
    this.#meter.note(peer.sessionId, performance.now(), silence);
    if (silence) return;

    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    if (!peer.decoder) {
      peer.gain = ctx.createGain();
      peer.gain.gain.value = 1;
      peer.gain.connect(this.#master);
      peer.decoder = new AudioDecoder({
        output: (data) => this.#play(peer, data),
        error: (error) => {
          this.#state = { ...this.#state, error: `Could not decode ${peer.name}: ${error.message}` };
          this.#emit();
        },
      });
      peer.decoder.configure({
        codec: 'opus',
        sampleRate: VOICE_SAMPLE_RATE,
        numberOfChannels: 1,
      });
    }
    const payload = frame.subarray(VOICE_HEADER_BYTES);
    if (payload.byteLength === 0 || peer.decoder.state !== 'configured') return;
    peer.decoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((header.timestamp * 1_000_000) / VOICE_SAMPLE_RATE),
        data: payload,
      }),
    );
  }

  #play(peer: Peer, data: AudioData): void {
    const ctx = this.#ctx;
    if (!ctx || !peer.gain) {
      data.close();
      return;
    }
    const frames = data.numberOfFrames;
    const pcm = new Float32Array(frames);
    try {
      data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      // A decoder that will not convert: take the first channel as it is.
      data.copyTo(pcm, { planeIndex: 0 });
    } finally {
      data.close();
    }
    const buffer = ctx.createBuffer(1, frames, data.sampleRate || VOICE_SAMPLE_RATE);
    buffer.copyToChannel(pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(peer.gain);
    source.start(peer.jitter.next(ctx.currentTime));
  }

  // --- capturing what we say -----------------------------------------------------

  async #ensureContext(): Promise<AudioContext> {
    if (this.#ctx) {
      if (this.#ctx.state === 'suspended') await this.#ctx.resume().catch(() => undefined);
      return this.#ctx;
    }
    const ctx = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    this.#ctx = ctx;
    this.#master = ctx.createGain();
    this.#master.connect(ctx.destination);
    // Autoplay: a context made outside a gesture starts suspended in most
    // browsers. The next key or click anywhere on the page unlocks it.
    if (ctx.state === 'suspended') {
      const unlock = (): void => {
        void ctx.resume();
        this.#unlock?.();
      };
      window.addEventListener('keydown', unlock, { once: true });
      window.addEventListener('pointerdown', unlock, { once: true });
      this.#unlock = () => {
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('pointerdown', unlock);
        this.#unlock = null;
      };
    }
    return ctx;
  }

  async #ensureMic(): Promise<void> {
    if (this.#mic || this.#stopped || this.#state.support !== 'ok') return;
    if (this.#micPending) return this.#micPending;
    this.#micPending = this.#openMic().finally(() => {
      this.#micPending = null;
    });
    return this.#micPending;
  }

  async #openMic(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.#state.deviceId ? { deviceId: { exact: this.#state.deviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : '';
      this.#state = {
        ...this.#state,
        support: name === 'NotAllowedError' ? 'blocked' : this.#state.support,
        mic: 'off',
        error:
          name === 'NotAllowedError'
            ? 'Microphone access was refused. Allow it for this site to talk.'
            : name === 'NotFoundError'
              ? 'No microphone was found.'
              : `Could not open the microphone: ${error instanceof Error ? error.message : String(error)}`,
      };
      this.#muted = true;
      this.#talking = false;
      this.#emit();
      return;
    }
    if (this.#stopped) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }

    const ctx = await this.#ensureContext();
    if (!this.#workletLoaded) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      this.#workletLoaded = true;
    }
    this.#mic = stream;
    this.#micSource = ctx.createMediaStreamSource(stream);
    this.#capture = new AudioWorkletNode(ctx, 'quintal-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    // A worklet only runs while it is part of the graph that reaches the
    // output; a silent gain keeps it there without letting the mic be heard.
    this.#sink = ctx.createGain();
    this.#sink.gain.value = 0;
    this.#micSource.connect(this.#capture);
    this.#capture.connect(this.#sink);
    this.#sink.connect(ctx.destination);
    this.#capture.port.onmessage = (event: MessageEvent<Float32Array>) => this.#captured(event.data);

    this.#encoder = new AudioEncoder({
      output: (chunk) => this.#encoded(chunk),
      error: (error) => {
        this.#state = { ...this.#state, error: `The encoder failed: ${error.message}` };
        this.#emit();
      },
    });
    const config: OpusEncoderConfig = {
      codec: 'opus',
      sampleRate: VOICE_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: VOICE_BITRATE,
      opus: { application: 'voip', usedtx: true, frameDuration: 20_000 },
    };
    this.#encoder.configure(config);

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.#state = {
        ...this.#state,
        devices: devices
          .filter((device) => device.kind === 'audioinput')
          .map((device, index) => ({ id: device.deviceId, label: device.label || `Microphone ${index + 1}` })),
      };
    } catch {
      // No list is not a failure; the default microphone is still open.
    }
    this.#state = { ...this.#state, error: null };
    this.#emit();
  }

  #releaseMic(): void {
    if (!this.#mic && !this.#capture && !this.#encoder) return;
    this.#capture?.port.close();
    this.#capture?.disconnect();
    this.#micSource?.disconnect();
    this.#sink?.disconnect();
    this.#sink = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    try {
      this.#encoder?.close();
    } catch {
      // Already closed.
    }
    this.#capture = null;
    this.#micSource = null;
    this.#mic = null;
    this.#encoder = null;
    this.#pendingMeta.length = 0;
  }

  #sending(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN && (this.#talking || !this.#muted);
  }

  #captured(pcm: Float32Array): void {
    const encoder = this.#encoder;
    if (!encoder || encoder.state !== 'configured') return;
    const timestamp = this.#sampleClock;
    this.#sampleClock = (this.#sampleClock + VOICE_FRAME_SAMPLES) >>> 0;
    if (!this.#sending()) return;

    const level = levelDbov(pcm);
    const silence = isSilence(level);
    if (silence) {
      this.#silenceRun += 1;
      // A few silence frames tell the far end the talking stopped; after
      // that, sending nothing is what DTX means.
      if (this.#silenceRun > SILENCE_FRAMES_SENT) return;
    } else {
      this.#silenceRun = 0;
      this.#selfSpeakingUntil = performance.now() + SELF_SPEAKING_MS;
    }

    this.#pendingMeta.push({ level, flags: silence ? VOICE_FLAG_DTX : 0, timestamp });
    encoder.encode(
      new AudioData({
        format: 'f32',
        sampleRate: VOICE_SAMPLE_RATE,
        numberOfFrames: pcm.length,
        numberOfChannels: 1,
        timestamp: Math.round((timestamp * 1_000_000) / VOICE_SAMPLE_RATE),
        // The worklet transferred this buffer whole; it is exactly the frame.
        data: pcm.buffer as ArrayBuffer,
      }),
    );
  }

  #encoded(chunk: EncodedAudioChunk): void {
    const meta = this.#pendingMeta.shift();
    const ws = this.#ws;
    if (!meta || !ws || ws.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(VOICE_HEADER_BYTES + chunk.byteLength);
    chunk.copyTo(out.subarray(VOICE_HEADER_BYTES));
    packVoiceHeader(out, {
      seq: this.#seq,
      timestamp: meta.timestamp,
      level: meta.level,
      flags: meta.flags,
    });
    this.#seq = (this.#seq + 1) & 0xffff;
    ws.send(out);
  }

  // --- telling ---------------------------------------------------------------------

  #emit(): void {
    const mic: VoiceUiState['mic'] = !this.#mic ? 'off' : this.#sending() ? 'live' : 'muted';
    this.#state = {
      ...this.#state,
      mic,
      talking: this.#talking,
      speaking: [...this.#lit],
    };
    const encoded = JSON.stringify(this.#state);
    if (encoded === this.#lastEmitted) return;
    this.#lastEmitted = encoded;
    this.#opts.onState(this.#state);
  }
}
