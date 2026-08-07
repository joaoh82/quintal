import type { MapZone } from '../map.js';
import type { Direction, PlayerKind } from '../player.js';

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
