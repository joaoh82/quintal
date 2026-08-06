/**
 * Map + zone types. No map data ships yet — this is the vocabulary the tile map
 * and the room logic will agree on.
 */

/**
 * What a region of the office is for. Zones drive proximity audio grouping,
 * permissions, and (later) which agents are allowed to park where.
 */
export type ZoneKind =
  /** Personal desk. One occupant, usually its owner. */
  | 'desk'
  /** Meeting room: everyone inside hears everyone inside, regardless of distance. */
  | 'meeting'
  /** Open social area — proximity rules apply normally. */
  | 'lounge'
  /** Broadcast area: occupants are heard by the whole room. */
  | 'stage'
  /** Where idle agents wait to be assigned work. */
  | 'agent-bay'
  /** Impassable geometry (walls, furniture). */
  | 'blocked';

/** Axis-aligned rectangle in tile coordinates. */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapZone {
  id: string;
  kind: ZoneKind;
  /** Human-readable label rendered on the map. */
  name: string;
  bounds: TileRect;
  /** Hard cap on occupants; `null` means unlimited. */
  capacity: number | null;
}

/** A tile map definition, loaded by the server and mirrored to clients. */
export interface OfficeMap {
  id: string;
  name: string;
  /** Map size in tiles. */
  width: number;
  height: number;
  /** Where a newly joined player is placed. */
  spawn: { x: number; y: number };
  zones: MapZone[];
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

export function zoneAt(map: OfficeMap, x: number, y: number): MapZone | null {
  return map.zones.find((zone) => isInsideZone(zone, x, y)) ?? null;
}
