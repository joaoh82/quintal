import {
  DEFAULT_OFFICE_SETTINGS,
  type VoiceOccupant,
} from '@quintal/shared';
import {
  RemoteAudioTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client';

import { resolveTargets, needsVoice, type VoiceTarget } from './spatial';

/**
 * Proximity voice between humans.
 *
 * Deliberately outside React and outside Phaser. It polls positions several
 * times a second and touches WebAudio nodes directly — neither belongs in a
 * render tree, and neither belongs in the game loop either.
 *
 * Three rules shape the whole file:
 *
 * **Agents never connect.** They have no microphone by design, so there is no
 * branch here that could grow one. `resolveTargets` drops them; nothing else
 * needs to know.
 *
 * **Alone means disconnected.** The primary user sits in this office all day
 * with a fleet of agents and no other humans. Holding a media connection open
 * for that costs a WebSocket, a mic permission prompt and battery, in exchange
 * for nothing. We connect on the second human and drop when they leave.
 *
 * **The mic starts muted, always.** An office you can walk into and be heard
 * in without touching anything is one people stop leaving open.
 */

export type VoiceState =
  | 'idle'
  | 'unavailable'
  | 'connecting'
  | 'connected'
  | 'blocked'
  | 'error';

export interface VoiceSnapshot {
  state: VoiceState;
  muted: boolean;
  /** Identity ids currently audible. */
  hearing: string[];
  /** Identity ids the office says are talking. */
  speaking: string[];
  detail: string;
}

interface Peer {
  gain: GainNode;
  panner: PannerNode;
  element: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
}

/** How often to recompute who we can hear. Four times a second reads as instant. */
const PROXIMITY_MS = 250;

/** Smoothing for gain and pan changes. Long enough to hide stepping, short enough to track a walk. */
const SMOOTHING = 0.08;

export class VoiceManager {
  #room: Room | null = null;
  #context: AudioContext | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  readonly #peers = new Map<string, Peer>();
  readonly #subscribed = new Set<string>();
  #speaking: string[] = [];

  #state: VoiceState = 'idle';
  #detail = '';
  #muted = true;
  #connecting = false;
  #stopped = false;
  #radiusTiles = DEFAULT_OFFICE_SETTINGS.voiceRadiusTiles;
  #deviceId: string | undefined;

  constructor(
    private readonly occupants: () => VoiceOccupant[],
    private readonly onChange: (snapshot: VoiceSnapshot) => void,
  ) {}

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => void this.#tick(), PROXIMITY_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#disconnect('left');
  }

  setRadius(tiles: number): void {
    this.#radiusTiles = tiles;
  }

  get snapshot(): VoiceSnapshot {
    return {
      state: this.#state,
      muted: this.#muted,
      hearing: [...this.#subscribed],
      speaking: this.#speaking,
      detail: this.#detail,
    };
  }

  /**
   * Browsers refuse to play audio until the page has been interacted with.
   * Called from the first real gesture, whatever it was — clicking, typing,
   * walking. Cheaper and less insulting than a splash screen demanding a click
   * before you can enter a room you may not want audio in.
   */
  resumeAudio(): void {
    void this.#context?.resume().then(() => {
      if (this.#state === 'blocked') this.#publish('connected', '');
    });
  }

  async setMuted(muted: boolean): Promise<void> {
    this.#muted = muted;
    await this.#room?.localParticipant.setMicrophoneEnabled(!muted, {
      deviceId: this.#deviceId,
    });
    this.#publish(this.#state, this.#detail);
  }

  /** Switch microphone. Applied live if we are connected, remembered if not. */
  async setDevice(deviceId: string): Promise<void> {
    this.#deviceId = deviceId;
    if (this.#room && !this.#muted) {
      await this.#room.switchActiveDevice('audioinput', deviceId);
    }
    this.#publish(this.#state, this.#detail);
  }

  // --- the loop ------------------------------------------------------------

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    const occupants = this.occupants();

    if (!needsVoice(occupants)) {
      // Everyone else left. Drop the connection rather than idle on it.
      if (this.#room) await this.#disconnect('alone');
      return;
    }

    if (!this.#room) {
      await this.#connect();
      return;
    }

    const { hear, drop } = resolveTargets(occupants, this.#radiusTiles, this.#subscribed);

    for (const identityId of drop) this.#unsubscribe(identityId);
    for (const target of hear) this.#applyTarget(target);

    if (drop.length > 0) this.#publish(this.#state, this.#detail);
  }

  async #connect(): Promise<void> {
    if (this.#connecting || this.#stopped) return;
    this.#connecting = true;
    this.#publish('connecting', '');

    try {
      const response = await fetch('/api/livekit/token', { method: 'POST' });
      if (response.status === 501) {
        // Not an error: an instance without LiveKit configured is a valid
        // instance. Say so once and stop trying.
        this.#publish('unavailable', 'Voice is not configured on this office.');
        this.#stopped = true;
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        return;
      }
      if (!response.ok) throw new Error(`token endpoint returned ${response.status}`);

      const { token, url } = (await response.json()) as { token: string; url: string };
      if (this.#stopped) return;

      // autoSubscribe false is the whole design: we choose who to hear, by
      // distance, rather than receiving everybody and turning them down.
      const room = new Room({ adaptiveStream: false, dynacast: true });
      this.#wire(room);
      await room.connect(url, token, { autoSubscribe: false });
      if (this.#stopped) {
        await room.disconnect();
        return;
      }

      this.#room = room;
      this.#context ??= new AudioContext();
      // Published immediately but muted — publishing on first unmute would
      // add a visible delay to the one action people expect to be instant.
      await room.localParticipant.setMicrophoneEnabled(false);

      this.#publish(this.#context.state === 'suspended' ? 'blocked' : 'connected', '');
    } catch (error: unknown) {
      this.#publish('error', error instanceof Error ? error.message : 'voice failed');
    } finally {
      this.#connecting = false;
    }
  }

  #wire(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === Track.Kind.Audio) this.#attach(participant.identity, track);
    });
    room.on(RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
      this.#detach(participant.identity);
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this.#speaking = speakers.map((speaker) => speaker.identity);
      this.#publish(this.#state, this.#detail);
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      this.#unsubscribe(participant.identity);
      this.#detach(participant.identity);
    });
    room.on(RoomEvent.Disconnected, () => {
      // Not our doing. Forget what we thought we were hearing so the next tick
      // rebuilds subscriptions from scratch rather than trusting stale state.
      this.#subscribed.clear();
      this.#room = null;
      if (!this.#stopped) this.#publish('connecting', 'Reconnecting…');
    });
    room.on(RoomEvent.Reconnected, () => {
      this.#subscribed.clear();
      this.#publish('connected', '');
    });
  }

  // --- subscriptions and audio graph ---------------------------------------

  #publicationFor(identityId: string): RemoteTrackPublication | undefined {
    const participant = this.#room?.remoteParticipants.get(identityId);
    if (!participant) return undefined;
    for (const publication of participant.trackPublications.values()) {
      if (publication.kind === Track.Kind.Audio) return publication;
    }
    return undefined;
  }

  #applyTarget(target: VoiceTarget): void {
    if (!this.#subscribed.has(target.identityId)) {
      const publication = this.#publicationFor(target.identityId);
      if (!publication) return;
      publication.setSubscribed(true);
      this.#subscribed.add(target.identityId);
      this.#publish(this.#state, this.#detail);
    }

    const peer = this.#peers.get(target.identityId);
    const context = this.#context;
    if (!peer || !context) return;

    const at = context.currentTime;
    peer.gain.gain.setTargetAtTime(target.gain, at, SMOOTHING);
    peer.panner.positionX.setTargetAtTime(target.position.x, at, SMOOTHING);
    peer.panner.positionY.setTargetAtTime(target.position.y, at, SMOOTHING);
    peer.panner.positionZ.setTargetAtTime(target.position.z, at, SMOOTHING);
  }

  #unsubscribe(identityId: string): void {
    if (!this.#subscribed.delete(identityId)) return;
    this.#publicationFor(identityId)?.setSubscribed(false);
  }

  /**
   * Route a remote track through WebAudio.
   *
   * The muted `<audio>` element is not redundant. Chrome will not run a
   * MediaStream through WebAudio unless the stream is also attached to a media
   * element somewhere; without it the graph is silent and nothing says why.
   */
  #attach(identityId: string, track: RemoteAudioTrack | Track): void {
    const context = this.#context;
    if (!context || !(track instanceof RemoteAudioTrack)) return;
    this.#detach(identityId);

    const stream = new MediaStream([track.mediaStreamTrack]);
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    void element.play().catch(() => {
      /* the WebAudio graph carries the sound; this element is a keep-alive */
    });

    const source = context.createMediaStreamSource(stream);
    const panner = new PannerNode(context, {
      panningModel: 'HRTF',
      distanceModel: 'linear',
      // Distance is handled by our own gain curve, so the panner is left to do
      // direction only. Two falloffs multiplied is a voice nobody can hear.
      refDistance: 1,
      maxDistance: 1,
      rolloffFactor: 0,
    });
    const gain = context.createGain();
    gain.gain.value = 0;

    source.connect(panner).connect(gain).connect(context.destination);
    this.#peers.set(identityId, { gain, panner, element, source });
  }

  #detach(identityId: string): void {
    const peer = this.#peers.get(identityId);
    if (!peer) return;
    peer.source.disconnect();
    peer.panner.disconnect();
    peer.gain.disconnect();
    peer.element.srcObject = null;
    this.#peers.delete(identityId);
  }

  async #disconnect(why: string): Promise<void> {
    for (const identityId of [...this.#peers.keys()]) this.#detach(identityId);
    this.#subscribed.clear();
    this.#speaking = [];

    const room = this.#room;
    this.#room = null;
    if (room) await room.disconnect().catch(() => {});

    this.#muted = true;
    if (this.#state !== 'unavailable') this.#publish('idle', why === 'alone' ? '' : why);
  }

  #publish(state: VoiceState, detail: string): void {
    this.#state = state;
    this.#detail = detail;
    this.onChange(this.snapshot);
  }
}
