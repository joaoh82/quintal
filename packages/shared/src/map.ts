import type { PlayerKind } from './player.js';

/**
 * Map + zone model. This is the *parsed* shape — the source of truth is the
 * Tiled map at `packages/shared/maps/hq.json`, turned into these types by
 * `parseTiledMap` in `./game/tiled.ts`. Both the browser and (later) the game
 * server read the same file through the same parser.
 */

/**
 * What a region of the office is for. These are exactly the values a `kind`
 * property may take on a rectangle in the map's `zones` object layer — keep
 * them in sync with what map authors type into Tiled.
 */
export type ZoneKind =
  /** A room you can close off: meetings, focus time. Proximity stops at the walls. */
  | 'private'
  /** Where people arrive. Nothing may block a spawn zone. */
  | 'spawn'
  /** Home turf for agents — docks, workstations, the place a fleet idles. */
  | 'agent_area';

export const ZONE_KINDS: readonly ZoneKind[] = ['private', 'spawn', 'agent_area'];

export function isZoneKind(value: string): value is ZoneKind {
  return (ZONE_KINDS as readonly string[]).includes(value);
}

/** Axis-aligned rectangle in tile coordinates. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapZone {
  /** Stable id from the map's `zoneId` property. Used in messages and state. */
  id: string;
  kind: ZoneKind;
  /** Human-readable label, rendered on the map. */
  label: string;
  /** Bounds in tiles. */
  bounds: TileRect;
}

/** A point in the map where someone can be placed. */
export interface SpawnPoint {
  name: string;
  kind: PlayerKind;
  /** Tile coordinates. */
  x: number;
  y: number;
}

/** A tile map, parsed and ready for both rendering and simulation. */
export interface OfficeMap {
  name: string;
  /** Size in tiles. */
  width: number;
  height: number;
  /** Pixels per tile. */
  tileSize: number;
  zones: MapZone[];
  spawns: SpawnPoint[];
  /**
   * Row-major `width * height` walkability grid derived from the collision
   * layers. `true` means a player may stand here.
   */
  walkable: boolean[];
}

export function isInsideZone(zone: MapZone, x: number, y: number): boolean {
  const { bounds } = zone;
  return (
    x >= bounds.x &&
    x < bounds.x + bounds.width &&
    y >= bounds.y &&
    y < bounds.y + bounds.height
  );
}

/** The zone containing a tile, if any. Later zones win on overlap. */
export function zoneAt(map: OfficeMap, x: number, y: number): MapZone | null {
  for (let i = map.zones.length - 1; i >= 0; i -= 1) {
    const zone = map.zones[i];
    if (zone && isInsideZone(zone, x, y)) return zone;
  }
  return null;
}

export function isWalkable(map: OfficeMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.walkable[y * map.width + x] === true;
}

/**
 * A walkable tile to stand on when you have been asked to come to somebody.
 *
 * Not their tile — two people do not share one, and an agent that routed onto
 * the person who called it would either fail to arrive or look like it had
 * walked through them. This returns the nearest free tile *beside* them.
 *
 * Searched in rings outward, so the answer is the closest one rather than
 * whichever direction happens to be checked first: being asked to come here and
 * arriving four tiles away because north was scanned before south is the kind
 * of thing nobody reports as a bug and everybody notices.
 *
 * `occupied` keeps two agents from being sent to the same tile when both are
 * called at once. Null when there is genuinely nowhere to stand — a person
 * boxed into a corner — which the caller should report rather than paper over.
 */
export function tileBeside(
  map: OfficeMap,
  x: number,
  y: number,
  occupied: ReadonlySet<string> = new Set(),
  maxRings = 4,
): { x: number; y: number } | null {
  for (let ring = 1; ring <= maxRings; ring += 1) {
    const candidates: Array<{ x: number; y: number }> = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        // Only the edge of this ring; the inside was covered by earlier ones.
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({ x: x + dx, y: y + dy });
      }
    }
    // Closest first within the ring, so a diagonal never beats an orthogonal
    // neighbour at the same ring distance.
    candidates.sort(
      (a, b) =>
        (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2),
    );
    for (const tile of candidates) {
      if (!isWalkable(map, tile.x, tile.y)) continue;
      if (occupied.has(`${tile.x},${tile.y}`)) continue;
      return tile;
    }
  }
  return null;
}

/** First spawn point of a kind, falling back to the middle of the map. */
export function spawnFor(map: OfficeMap, kind: PlayerKind): SpawnPoint {
  const found = map.spawns.find((spawn) => spawn.kind === kind);
  return (
    found ?? {
      name: 'fallback',
      kind,
      x: Math.floor(map.width / 2),
      y: Math.floor(map.height / 2),
    }
  );
}
