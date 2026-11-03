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

  /** Somebody left: this is the newest word on where they are. */
  left(key: string, place: LastPlace): void {
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

  /**
   * A dropped seat ran out its reconnection grace with nobody resuming it. It
   * counts only as a last resort, since a page reload lands here twenty seconds
   * late: not while another session of theirs is in the room, which is where
   * they are, and not over a spot already kept, which is newer than this.
   */
  seatExpired(key: string, place: LastPlace, stillHere: boolean): void {
    if (stillHere || this.#places.has(key)) return;
    this.left(key, place);
  }

  /**
   * The spot for an arrival. Used once: the session it goes to now owns it.
   *
   * `heldSeat` is a dropped seat of theirs still in its grace, which is where
   * a reload comes back to, having never left. A kept spot beats it: that was
   * a real leave, and it can only have come after the drop.
   */
  take(key: string, heldSeat: LastPlace | null = null): LastPlace | null {
    const place = this.#places.get(key) ?? heldSeat;
    this.#places.delete(key);
    return place;
  }
}
