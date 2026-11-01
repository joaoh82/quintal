import type { Pose } from '@quintal/shared';

/**
 * Who sits where, and how.
 *
 * A busy agent used to stand wherever it had spawned with a balloon over its
 * head, and an agent on a task for days stood the same way as one with
 * nothing to do. This gives the work a place: an agent that starts a turn
 * walks to its desk and types, one that holds a task but has nothing running
 * sits at it, and one with neither is on its feet, free to wander. None of
 * it asks a model anything, and none of it is the agent's to set: the pose
 * follows the status line and the task, which the office already knows, so
 * an agent cannot look busy while idle or idle while busy.
 *
 * Pure on purpose, like idle life. The room owns the clock, the map and the
 * avatars; this module owns two rules — which pose a state calls for, and
 * which desk an agent gets — so the rule that can seat two agents on one
 * chair is pinned without a room.
 */

/**
 * The pose an agent's state calls for.
 *
 * `busy` is the status line not being idle-capable: a turn is running. `onTask`
 * is a task held, as its harness last said. Busy wins, because a turn runs
 * whether or not a task is under it; a task with nothing running is the
 * posture the harness rule asks for — an agent on a task for days must still
 * read as idle, and sitting still is what idle at a desk looks like.
 */
export function wantedPose(input: { busy: boolean; onTask: boolean }): Pose {
  if (input.busy) return 'work';
  if (input.onTask) return 'sit';
  return 'stand';
}

/** A pose that has the agent at its desk. */
export function seated(pose: Pose): boolean {
  return pose !== 'stand';
}

/** One agent, as the room sees it on a sweep. */
export interface SeatingInput {
  agentId: string;
  /** The pose its state calls for. */
  wanted: Pose;
  /**
   * The pose the office last arranged for this session, if any: recorded by
   * the room when a plan is carried out, and never for `wait`. Per session,
   * not per agent, because a fresh session spawns at the door whatever its
   * last one had been given.
   */
  arranged: Pose | undefined;
  /** Standing still on its own chair. */
  atSeat: boolean;
  /** Whether the office may move it. */
  canMove: boolean;
}

export type SeatingPlan =
  /** Nothing to do: as arranged, or standing somewhere on purpose. */
  | { kind: 'stay' }
  /** Off the chair, which is nobody's floor. */
  | { kind: 'rise'; seat: string }
  /** On the chair already: take the pose. */
  | { kind: 'settle'; seat: string; pose: Pose }
  /** To the desk, which is this agent's from now. */
  | { kind: 'walk'; seat: string; pose: Pose }
  /** Wants a desk and every one is held by somebody here. Asked again next sweep. */
  | { kind: 'wait' };

/**
 * The book of desks: which agent holds which seat.
 *
 * Keyed by the agent's stable id, not its session, so a reconnect keeps the
 * chair. An assignment outlives the agent's presence — the same agent sits at
 * the same desk tomorrow — until a present agent needs a desk and none is
 * free, when the longest-absent holder's goes first. Never two holders of one
 * seat, and never a refusal that could have been a desk: the only `null` is
 * every seat held by somebody who is here.
 */
export class SeatBook {
  readonly #seats: readonly string[];
  /** agent id -> seat id */
  readonly #held = new Map<string, string>();
  /** agent id -> when it was last here, ms since epoch; absent means present. */
  readonly #leftAt = new Map<string, number>();

  constructor(seats: readonly string[]) {
    this.#seats = seats;
  }

  get size(): number {
    return this.#seats.length;
  }

  seatOf(agentId: string): string | undefined {
    return this.#held.get(agentId);
  }

  holderOf(seatId: string): string | undefined {
    for (const [agentId, held] of this.#held) if (held === seatId) return agentId;
    return undefined;
  }

  /**
   * The desk for this agent, giving it one if it has none: the one it
   * already holds, else the first free seat, else the seat of whoever has
   * been gone longest. `null` when every seat is held by somebody present.
   */
  claim(agentId: string, now: number): string | null {
    this.#leftAt.delete(agentId);
    const held = this.#held.get(agentId);
    if (held !== undefined) return held;

    const taken = new Set(this.#held.values());
    const free = this.#seats.find((seat) => !taken.has(seat));
    if (free !== undefined) {
      this.#held.set(agentId, free);
      return free;
    }

    let evict: string | undefined;
    let longest = now;
    for (const [other, leftAt] of this.#leftAt) {
      if (leftAt <= longest && this.#held.has(other)) {
        longest = leftAt;
        evict = other;
      }
    }
    if (evict === undefined) return null;
    const seat = this.#held.get(evict)!;
    this.#held.delete(evict);
    this.#leftAt.delete(evict);
    this.#held.set(agentId, seat);
    return seat;
  }

  /** The agent is here: its desk, if it has one, is not up for taking. */
  arrived(agentId: string): void {
    this.#leftAt.delete(agentId);
  }

  /** The agent has gone. It keeps its desk until somebody present needs it. */
  left(agentId: string, now: number): void {
    if (this.#held.has(agentId)) this.#leftAt.set(agentId, now);
  }

  /** Give the desk up for good. */
  release(agentId: string): void {
    this.#held.delete(agentId);
    this.#leftAt.delete(agentId);
  }

  /**
   * What to do about one agent this sweep.
   *
   * Driven by change, not by the clock: a seated pose already arranged for
   * this session is `stay` wherever the agent is, because an agent its model
   * walked across the room mid-turn is standing there on purpose. `wait` is
   * the exception. An agent that wanted a desk and got none has had nothing
   * arranged, so the room records nothing and asks again next sweep, and the
   * first desk a leaver frees is this agent's. Recording the refusal as
   * handled was how an agent stood through a whole turn beside a chair that
   * had since come free.
   */
  plan(input: SeatingInput, now: number): SeatingPlan {
    const { agentId, wanted, arranged, atSeat, canMove } = input;
    const seat = this.#held.get(agentId);
    if (!seated(wanted)) {
      return atSeat && canMove && seat !== undefined ? { kind: 'rise', seat } : { kind: 'stay' };
    }
    if (arranged === wanted) return { kind: 'stay' };
    if (atSeat && seat !== undefined) return { kind: 'settle', seat, pose: wanted };
    if (!canMove) return { kind: 'stay' };
    const desk = this.claim(agentId, now);
    return desk === null ? { kind: 'wait' } : { kind: 'walk', seat: desk, pose: wanted };
  }
}
