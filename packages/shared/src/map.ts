import type { Direction, PlayerKind } from './player.js';

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
  /**
   * A named part of the floor anybody may be in: the corridor, the cafeteria,
   * the garden. It gets a label and a conversation of its own like any zone,
   * but unlike `private` it is somewhere an idling agent may wander — which is
   * the whole difference between a shared space and a room with a door.
   */
  | 'common'
  /** Where people arrive. Nothing may block a spawn zone. */
  | 'spawn'
  /** Home turf for agents — docks, workstations, the place a fleet idles. */
  | 'agent_area';

export const ZONE_KINDS: readonly ZoneKind[] = ['private', 'common', 'spawn', 'agent_area'];

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

/**
 * What a thing in the office does when you use it. Exactly the values a `kind`
 * property may take on a rectangle in the map's `interactables` object layer.
 */
export type InteractableKind =
  /** The office board: walk up to the noticeboard and press E, or click it. */
  'board';

export const INTERACTABLE_KINDS: readonly InteractableKind[] = ['board'];

export function isInteractableKind(value: string): value is InteractableKind {
  return (INTERACTABLE_KINDS as readonly string[]).includes(value);
}

/**
 * Something on the map you can use by standing by it. The bounds are the
 * tiles you stand on to use it — the floor in front of a noticeboard, not the
 * wall it hangs on — and `prop` names the sprite it belongs to, so the
 * renderer can light it up and take a click on it.
 */
export interface MapInteractable {
  /** Stable id from the map's `interactableId` property. */
  id: string;
  kind: InteractableKind;
  /** What the prompt calls it: "the board". */
  label: string;
  /** Where to stand, in tiles. */
  bounds: TileRect;
  /** The `sprite` of the prop this belongs to, or null if it is a bare patch of floor. */
  prop: string | null;
  /**
   * Where that prop's visible part is drawn, in pixels, for lighting it up.
   * The renderer only has the prop's cell; the map builder knows the art.
   * Null when there is no prop, or nothing recorded about its size.
   */
  halo: PixelRect | null;
}

/** Axis-aligned rectangle in map pixels. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A chair at a desk, from the map's `seats` object layer.
 *
 * A seat is one tile that only its holder may stand on: the map's walkable
 * grid has it blocked, so nobody paths through a chair, and the office opens
 * it for the one agent it has given the desk to (`withSeatOpen`). `facing`
 * is the way the chair points, which is the way the sitter faces. `screen`
 * is where the desk's laptop is drawn, in pixels, for the renderer to light
 * up and take a click on; null for a seat with nothing to look at.
 */
export interface MapSeat {
  /** Stable id from the map's `seatId` property. What a player's `seat` names. */
  id: string;
  /** The chair's tile. */
  tile: { x: number; y: number };
  facing: Direction;
  screen: PixelRect | null;
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
  interactables: MapInteractable[];
  /** Desks an agent may be given, in the order the office hands them out. */
  seats: MapSeat[];
  spawns: SpawnPoint[];
  /**
   * Row-major `width * height` walkability grid derived from the collision
   * layers, with every seat blocked. `true` means anyone may stand here.
   */
  walkable: boolean[];
}

/** The seat on a tile, if any. */
export function seatAt(map: OfficeMap, x: number, y: number): MapSeat | null {
  return map.seats.find((seat) => seat.tile.x === x && seat.tile.y === y) ?? null;
}

/**
 * The same map with one seat walkable: what the office routes an agent on
 * when sending it to its own desk. Every other seat stays blocked, so a
 * route to one chair never cuts through another. A copy, never a mutation:
 * the parsed map is shared by every room and every pathfind.
 */
export function withSeatOpen(map: OfficeMap, seat: MapSeat): OfficeMap {
  const walkable = map.walkable.slice();
  const { x, y } = seat.tile;
  if (x >= 0 && y >= 0 && x < map.width && y < map.height) walkable[y * map.width + x] = true;
  return { ...map, walkable };
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

/** The interactable you are standing by, if any. Later ones win on overlap, like zones. */
export function interactableAt(map: OfficeMap, x: number, y: number): MapInteractable | null {
  for (let i = map.interactables.length - 1; i >= 0; i -= 1) {
    const interactable = map.interactables[i];
    if (!interactable) continue;
    const { bounds } = interactable;
    if (x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height) {
      return interactable;
    }
  }
  return null;
}

/**
 * Where to stand to use something, walking from `from`: the nearest tile of
 * its doorstep you can stand on. Null when the whole doorstep is blocked,
 * which the caller should treat as "cannot be used", not walk to anyway.
 */
export function nearestStandingTile(
  map: OfficeMap,
  interactable: MapInteractable,
  from: { x: number; y: number },
): { x: number; y: number } | null {
  const { bounds } = interactable;
  let best: { x: number; y: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (!isWalkable(map, x, y)) continue;
      const distance = (x - from.x) ** 2 + (y - from.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { x, y };
      }
    }
  }
  return best;
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
