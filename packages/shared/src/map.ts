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
