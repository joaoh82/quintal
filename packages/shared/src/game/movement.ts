import { isWalkable, type OfficeMap } from '../map.js';
import type { Direction } from '../player.js';

/**
 * The one movement implementation.
 *
 * The server runs this to stay authoritative; the client runs the *same* code
 * to predict locally. That is the whole point of it living in `shared`: two
 * implementations of "walk forward and stop at walls" will always drift, and
 * the drift shows up as rubber-banding that no amount of reconciliation tuning
 * really fixes.
 */

/** Walking speed in pixels per second (4 tiles/sec at 32px tiles). */
export const WALK_SPEED = 128;

/**
 * Half-width of the avatar's collision box, in pixels. Narrower than a tile so
 * a one-tile doorway is comfortably passable.
 */
export const PLAYER_HALF_SIZE = 9;

/** Server simulation and patch rate. 50ms is a good balance for a walking sim. */
export const TICK_RATE_HZ = 20;
export const TICK_MS = 1000 / TICK_RATE_HZ;

/** Movement intent: a direction vector, each component in [-1, 1]. */
export interface MoveIntent {
  x: number;
  y: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface StepResult extends Position {
  /** True if a wall stopped movement on at least one axis this step. */
  blocked: boolean;
}

/** Does the avatar's box at this position overlap anything solid? */
export function isBlockedAt(map: OfficeMap, x: number, y: number): boolean {
  const { tileSize } = map;
  const half = PLAYER_HALF_SIZE;

  // The -1e-6 keeps a box that ends exactly on a tile boundary from claiming
  // the next tile along, which would make doorways feel one pixel too narrow.
  const minTileX = Math.floor((x - half) / tileSize);
  const maxTileX = Math.floor((x + half - 1e-6) / tileSize);
  const minTileY = Math.floor((y - half) / tileSize);
  const maxTileY = Math.floor((y + half - 1e-6) / tileSize);

  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      if (!isWalkable(map, tileX, tileY)) return true;
    }
  }
  return false;
}

/**
 * Advance one step. Axes resolve independently so walking into a wall at an
 * angle slides along it instead of stopping dead.
 */
export function stepMovement(
  map: OfficeMap,
  from: Position,
  intent: MoveIntent,
  deltaSeconds: number,
): StepResult {
  const velocity = normalize(intent);
  if (velocity.x === 0 && velocity.y === 0) {
    return { x: from.x, y: from.y, blocked: false };
  }

  const distance = WALK_SPEED * deltaSeconds;
  let { x, y } = from;
  let blocked = false;

  const nextX = x + velocity.x * distance;
  if (isBlockedAt(map, nextX, y)) blocked = true;
  else x = nextX;

  const nextY = y + velocity.y * distance;
  if (isBlockedAt(map, x, nextY)) blocked = true;
  else y = nextY;

  return { x, y, blocked };
}

/** Scale a vector to unit length, so diagonals aren't faster than straights. */
export function normalize(intent: MoveIntent): MoveIntent {
  const length = Math.hypot(intent.x, intent.y);
  if (length === 0) return { x: 0, y: 0 };
  if (length <= 1) return intent;
  return { x: intent.x / length, y: intent.y / length };
}

/** Which way an avatar should face, given how it is moving. */
export function directionFromIntent(
  intent: MoveIntent,
  fallback: Direction,
): Direction {
  if (intent.x === 0 && intent.y === 0) return fallback;
  if (Math.abs(intent.x) > Math.abs(intent.y)) return intent.x > 0 ? 'right' : 'left';
  return intent.y > 0 ? 'down' : 'up';
}

/** Centre of a tile, in world pixels. */
export function tileCentre(tile: number, tileSize: number): number {
  return tile * tileSize + tileSize / 2;
}

/** Which tile a world coordinate falls in. */
export function toTile(world: number, tileSize: number): number {
  return Math.floor(world / tileSize);
}

/**
 * Follow a path of tile centres. Returns the new position and how many
 * waypoints were consumed — the caller owns the remaining path.
 */
export function followPath(
  map: OfficeMap,
  from: Position,
  path: readonly Position[],
  deltaSeconds: number,
): { position: Position; consumed: number; intent: MoveIntent } {
  let position = { x: from.x, y: from.y };
  let remaining = WALK_SPEED * deltaSeconds;
  let consumed = 0;
  let intent: MoveIntent = { x: 0, y: 0 };

  while (remaining > 0 && consumed < path.length) {
    const waypoint = path[consumed];
    if (!waypoint) break;

    const target = {
      x: tileCentre(waypoint.x, map.tileSize),
      y: tileCentre(waypoint.y, map.tileSize),
    };
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const distance = Math.hypot(dx, dy);

    if (distance === 0) {
      consumed += 1;
      continue;
    }

    intent = { x: dx / distance, y: dy / distance };

    if (distance <= remaining) {
      position = target;
      remaining -= distance;
      consumed += 1;
      continue;
    }

    position = {
      x: position.x + intent.x * remaining,
      y: position.y + intent.y * remaining,
    };
    remaining = 0;
  }

  return { position, consumed, intent };
}
