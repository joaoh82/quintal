import {
  FLOOR_ZONE_ID,
  emoteForStatus,
  findPath,
  isWalkable,
  zoneAt,
  type MapZone,
  type OfficeMap,
  type TilePoint,
} from '@quintal/shared';

/**
 * What an agent does when nobody needs it.
 *
 * An idle agent used to stand perfectly still, forever, which reads as dead
 * rather than available. This is the small life of somebody with nothing to
 * do in an office: after a while they wander their corner, after a long while
 * they doze off, and when two of them are at a loose end they stop beside
 * each other for a moment. None of it asks a model anything. Every decision
 * here is a random number and, at most, a pathfind.
 *
 * Pure on purpose. The room owns the clock, the map and the avatars; this
 * module owns the rules, with the random source injected so the rules can be
 * tested for what they must never do — move an agent that is busy.
 */

/** With nothing happening for this long, an agent starts to wander. */
export const IDLE_AFTER_MS = 90_000;
/** With nothing happening for this long, it dozes off where it stands. */
export const SLEEP_AFTER_MS = 10 * 60_000;
/** Between one wander and the next. */
export const WANDER_MIN_MS = 8_000;
export const WANDER_MAX_MS = 20_000;
/** How far one wander goes, in tiles. A few steps; never across the map. */
export const WANDER_RADIUS_TILES = 6;
/** Between one small talk and the next, per zone. */
export const SMALL_TALK_MIN_MS = 120_000;
export const SMALL_TALK_MAX_MS = 300_000;
/** How long a small talk lasts once they are face to face. */
export const SMALL_TALK_MS = 6_000;
/** How long the second party takes to answer with a balloon of their own. */
export const SMALL_TALK_REPLY_MS = 2_500;

/** A number in [0, 1). Injected so tests can decide what "random" picks. */
export type Rng = () => number;

export type IdlePhase = 'active' | 'wandering' | 'asleep';

/** A small talk in progress, from the point of view of one party. */
export interface SmallTalk {
  /** The other party's session. */
  partner: string;
  /** True for the one who walked over. */
  initiator: boolean;
  /** Set once both stand face to face; zero while still walking over. */
  startedAt: number;
  /** The reply balloon has gone up (the answering party only). */
  answered: boolean;
}

/** Everything the office remembers about one agent's idle life. */
export interface IdleRecord {
  /** When something last happened to or by this agent. */
  activeAt: number;
  phase: IdlePhase;
  /**
   * Where it was standing when it went idle — the zone it wanders in and
   * never leaves. The open floor counts as a zone.
   */
  homeZone: string;
  /** When to think about wandering again. Looked at once a second, not timed. */
  nextDecisionAt: number;
  talk: SmallTalk | null;
  /**
   * The balloon idle life put up, or empty. Remembered so that waking takes
   * down only its own balloon — never one the harness has just raised for
   * the turn that woke it.
   */
  balloon: string;
}

export function newIdleRecord(now: number): IdleRecord {
  return {
    activeAt: now,
    phase: 'active',
    homeZone: FLOOR_ZONE_ID,
    nextDecisionAt: 0,
    talk: null,
    balloon: '',
  };
}

/**
 * Is this agent free to idle, going by its status line?
 *
 * The harness narrates a turn on the nameplate — "thinking", "editing
 * auth.ts", "waiting for Josh" — and clears it when the turn ends. A standing
 * refusal ("no model … here") is not work, and an offline agent is not
 * available; neither should wander, for different reasons, and only the
 * refusal counts as idle.
 */
export function idleCapable(status: string): boolean {
  return status.length === 0 || emoteForStatus(status) === 'cross';
}

export type IdleAction =
  /** Nothing to do this second. */
  | { kind: 'none' }
  /** Pick a tile nearby and walk to it. */
  | { kind: 'wander' }
  /** Stop, and put the sleeping balloon up. */
  | { kind: 'sleep' }
  /**
   * Something happened while it was idling. The caller ends the idle life
   * with `wake` — it is not done here, because the room has a walk to
   * cancel, a balloon to take down and possibly a partner to release first.
   */
  | { kind: 'wake' };

/** Somewhere in [min, max). */
export function between(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min));
}

/**
 * One look at one agent, once a second.
 *
 * `busy` is the invariant's input: a busy agent never wanders, and if it was
 * idling when it became busy, this is where that ends. Busy also counts as
 * activity, so a long think with no office traffic does not slide into
 * wandering mid-turn.
 */
export function stepIdle(
  record: IdleRecord,
  input: { now: number; busy: boolean; zoneId: string },
  rng: Rng,
): IdleAction {
  const { now, busy, zoneId } = input;

  if (busy) {
    record.activeAt = now;
    return record.phase === 'active' ? { kind: 'none' } : { kind: 'wake' };
  }

  const elapsed = now - record.activeAt;

  if (elapsed < IDLE_AFTER_MS) {
    return record.phase === 'active' ? { kind: 'none' } : { kind: 'wake' };
  }

  if (elapsed >= SLEEP_AFTER_MS) {
    if (record.phase === 'asleep') return { kind: 'none' };
    record.phase = 'asleep';
    record.talk = null;
    return { kind: 'sleep' };
  }

  if (record.phase !== 'wandering') {
    record.phase = 'wandering';
    record.homeZone = zoneId;
    record.nextDecisionAt = now + between(rng, WANDER_MIN_MS, WANDER_MAX_MS);
    return { kind: 'none' };
  }

  // Not while stopped for a chat: drifting apart comes after.
  if (record.talk !== null) return { kind: 'none' };

  if (now >= record.nextDecisionAt) {
    record.nextDecisionAt = now + between(rng, WANDER_MIN_MS, WANDER_MAX_MS);
    return { kind: 'wander' };
  }

  return { kind: 'none' };
}

/**
 * Something happened to this agent. Returns true when it was idling, which
 * is the caller's cue to cancel the walk and bring the balloon down.
 */
export function wake(record: IdleRecord): boolean {
  const wasIdle = record.phase !== 'active';
  record.phase = 'active';
  record.talk = null;
  return wasIdle;
}

/** Note activity without touching the phase; the next step decides. */
export function touch(record: IdleRecord, now: number): void {
  record.activeAt = now;
}

/** The zone a tile is in, with the open floor as a zone of its own. */
export function zoneIdAt(map: OfficeMap, tile: TilePoint): string {
  return zoneAt(map, tile.x, tile.y)?.id ?? FLOOR_ZONE_ID;
}

/**
 * Somewhere nearby to wander to, or null to stay put.
 *
 * Inside the home zone, walkable, reachable, and at most a few tiles away —
 * "walk a little, stop" — and never into a private zone. If the home zone is
 * itself private there is nowhere to wander: an agent asked into the focus
 * room waits there quietly. Candidates are gathered, then one is drawn, so
 * every tile in reach is equally likely rather than the first one scanned.
 */
export function wanderTarget(
  map: OfficeMap,
  from: TilePoint,
  homeZone: string,
  rng: Rng,
  radius: number = WANDER_RADIUS_TILES,
): TilePoint | null {
  const home: MapZone | null = map.zones.find((zone) => zone.id === homeZone) ?? null;
  if (home?.kind === 'private') return null;

  const candidates: TilePoint[] = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const tile = { x: from.x + dx, y: from.y + dy };
      if (!isWalkable(map, tile.x, tile.y)) continue;
      if (zoneIdAt(map, tile) !== homeZone) continue;
      candidates.push(tile);
    }
  }

  // A few draws, because a walkable tile in the zone may still be walled off
  // from here; the pathfind is the cost, so it runs only on what was drawn.
  for (let attempt = 0; attempt < 4 && candidates.length > 0; attempt += 1) {
    const index = between(rng, 0, candidates.length);
    const [tile] = candidates.splice(index, 1);
    if (!tile) break;
    const path = findPath(map, from, tile);
    if (path.length === 0) continue;
    // Never through somewhere it may not go, even on the way.
    if (path.every((step) => zoneIdAt(map, step) === homeZone)) return tile;
  }
  return null;
}

/**
 * Who stops for a chat this second: at most one new pair per zone, and only
 * once the zone's cooldown is up.
 *
 * `free` lists idle, awake, unengaged agents by home zone. `nextTalkAt` is the
 * per-zone cooldown and is advanced here for every zone that pairs — the
 * caller keeps it between seconds.
 */
export function pickSmallTalk(
  free: ReadonlyMap<string, readonly string[]>,
  nextTalkAt: Map<string, number>,
  now: number,
  rng: Rng,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [zoneId, sessions] of free) {
    if (sessions.length < 2) continue;
    if (now < (nextTalkAt.get(zoneId) ?? 0)) continue;

    const first = between(rng, 0, sessions.length);
    let second = between(rng, 0, sessions.length - 1);
    if (second >= first) second += 1;
    const a = sessions[first];
    const b = sessions[second];
    if (a === undefined || b === undefined) continue;

    pairs.push([a, b]);
    nextTalkAt.set(zoneId, now + between(rng, SMALL_TALK_MIN_MS, SMALL_TALK_MAX_MS));
  }
  return pairs;
}
