import type { Direction } from '@quintal/shared';

/**
 * Where somebody was standing when they left the office.
 *
 * Going to Settings and back leaves the room and joins it again: a new
 * session, which used to mean the door, however far across the map you had
 * walked. So the office keeps your spot and hands it to your next arrival.
 *
 * Kept outside the room, because the room does not outlive the visit: if you
 * were alone in the office it closed behind you. In memory, because this is a
 * courtesy and not a record — a restart puts everybody at the door, and
 * nothing is lost by that. The client is never asked: an arrival it could name
 * would be a way to appear anywhere without walking there.
 */

export interface LastPlace {
  x: number;
  y: number;
  dir: Direction;
}

/** Far more people than one process will see; the oldest spot goes first. */
const MAX_PLACES = 10_000;

export class LastPlaces {
  readonly #places = new Map<string, LastPlace>();

  constructor(private readonly max = MAX_PLACES) {}

  /**
   * A session has gone. `held` says it was a dropped seat running out its
   * reconnection grace rather than somebody leaving: a page reload lands here
   * twenty seconds late, after the new session may already have come and gone,
   * so a spot already kept is newer than this one.
   */
  left(key: string, place: LastPlace, held: boolean): void {
    if (held && this.#places.has(key)) return;
    // Deleted first so that a returning key counts as the newest.
    this.#places.delete(key);
    this.#places.set(key, place);
    if (this.#places.size > this.max) {
      for (const oldest of this.#places.keys()) {
        this.#places.delete(oldest);
        break;
      }
    }
  }

  /** The spot for an arrival. Used once: the session it goes to now owns it. */
  take(key: string): LastPlace | null {
    const place = this.#places.get(key) ?? null;
    this.#places.delete(key);
    return place;
  }
}
