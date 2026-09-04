import type { MapZone } from '../map.js';
import type { Direction, PlayerKind } from '../player.js';
import type {
  ChannelChatPayload,
  ChannelsPayload,
  ChatBroadcastPayload,
  DmOpenedPayload,
  HistoryPayload,
} from './protocol.js';

/** One line in the roster panel. */
export interface RosterEntry {
  sessionId: string;
  name: string;
  kind: PlayerKind;
  status: string;
  isSelf: boolean;
  /** Agents: the human accountable for this one. Empty for humans. */
  ownerName: string;
  /** Agents: that human's `users.id`, so "is this one mine" is not a name match. */
  ownerUserId: string;
  /** Agents: what it is allowed to do. */
  scopes: string[];
  /**
   * Agents: `agents.id`, which is also the key of its audit log page. Humans
   * carry their user id here; the UI only ever links agents.
   */
  identityId: string;
  /** ms since epoch when this occupant last visibly did something. */
  lastActionAt: number;
  /** Humans: walked in through a guest link. Always false for agents. */
  isGuest: boolean;
  /** Humans: the profile line they wrote. Empty when unset. */
  description: string;
  /**
   * Humans: x-only public key, hex — render it as an npub. Empty for agents.
   *
   * Distinct from `identityId`, which is an internal row id and identifies
   * nobody to a human being.
   */
  pubkey: string;
}

/**
 * What the UI needs to know about the socket. `reconnecting` covers the
 * server-side grace period: the avatar is still standing in the room.
 */
export type ConnectionStatus =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'error';

/**
 * The bridge between the game and the UI.
 *
 * Game state lives inside Phaser, not React: a 60fps simulation must not push
 * every frame through a reconciler. React subscribes to the handful of moments
 * it actually needs to re-render for, and everything else stays in the scene.
 * Traffic goes one way — the game announces, the UI listens.
 */
// A type alias rather than an interface: interfaces have no implicit index
// signature, so they don't satisfy the emitter's `Record<string, unknown>`.
export type GameEvents = {
  /** The scene has finished loading the map and is rendering. */
  ready: { mapName: string; width: number; height: number };
  /** The local player entered or left a zone. Fires only on change. */
  zone: { zone: MapZone | null; previous: MapZone | null };
  /** Local player position, in tiles. Fires only when the tile changes. */
  tile: { x: number; y: number; direction: Direction; kind: PlayerKind };
  /** Debug overlay toggled with Z. */
  debug: { enabled: boolean };
  /** A click-to-move route was planned, or cleared (`length: 0`). */
  path: { length: number };
  /** Everyone currently in the room, self included. Fires on any change. */
  roster: { players: RosterEntry[]; selfSessionId: string | null };
  /** Someone within earshot spoke. */
  chat: ChatBroadcastPayload;
  /** What was said in a zone or channel before we were listening. */
  history: HistoryPayload;
  /** Somebody posted in a channel we are in. */
  channelChat: ChannelChatPayload;
  /** The channels we are in changed, or were first reported. */
  channels: ChannelsPayload;
  /** A DM we asked to open is open. */
  dmOpened: DmOpenedPayload;
  /** Socket state changed. `detail` is safe to show a human. */
  connection: { status: ConnectionStatus; detail?: string };
  /** The server rejected something — rate limit, bad move. */
  notice: { code: string; message: string };
};

export type GameEventName = keyof GameEvents;
export type GameEventListener<K extends GameEventName> = (payload: GameEvents[K]) => void;

/**
 * A tiny typed emitter. No dependency, because both a Phaser scene and a React
 * effect have to import it and neither should drag in the other's world.
 */
export class TypedEmitter<Events extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  /** Subscribe. Returns an unsubscribe function — convenient in `useEffect`. */
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener as (payload: never) => void);
    this.#listeners.set(event, set);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    // Copy first: a listener may unsubscribe itself while we iterate.
    for (const listener of [...set]) {
      (listener as (payload: Events[K]) => void)(payload);
    }
  }

  /** Drop every listener. Call when the game is destroyed. */
  clear(): void {
    this.#listeners.clear();
  }
}

export type GameBridge = TypedEmitter<GameEvents>;

export function createGameBridge(): GameBridge {
  return new TypedEmitter<GameEvents>();
}
