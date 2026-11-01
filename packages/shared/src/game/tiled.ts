import {
  INTERACTABLE_KINDS,
  ZONE_KINDS,
  isInteractableKind,
  isZoneKind,
  type MapInteractable,
  type MapSeat,
  type MapZone,
  type OfficeMap,
  type PixelRect,
  type SpawnPoint,
} from '../map.js';
import { DIRECTIONS, isDirection, type PlayerKind } from '../player.js';

/**
 * Just enough of the Tiled JSON format to read our own maps. Deliberately not a
 * complete Tiled implementation — if a map uses a feature that isn't here,
 * parsing should fail loudly rather than silently ignore it.
 */

export interface TiledProperty {
  name: string;
  type: string;
  value: string | number | boolean;
}

export interface TiledTileLayer {
  type: 'tilelayer';
  name: string;
  width: number;
  height: number;
  /** Row-major GIDs. 0 means empty. */
  data: number[];
  visible: boolean;
}

export interface TiledObject {
  id: number;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  point?: boolean;
  properties?: TiledProperty[];
}

export interface TiledObjectLayer {
  type: 'objectgroup';
  name: string;
  objects: TiledObject[];
}

export type TiledLayer = TiledTileLayer | TiledObjectLayer;

export interface TiledMap {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  properties?: TiledProperty[];
}

/** Layer names the parser expects to find. */
export const LAYERS = {
  floor: 'floor',
  walls: 'walls',
  /** Invisible. What the furniture actually blocks; see `props`. */
  collision: 'collision',
  /** Anchored sprites, drawn and depth-sorted rather than laid out on the grid. */
  props: 'props',
  spawns: 'spawns',
  zones: 'zones',
  /** Rectangles you stand in to use something: the floor in front of the noticeboard. */
  interactables: 'interactables',
  /** One tile each: the chairs an agent may be given. Blocked for everyone else. */
  seats: 'seats',
} as const;

/**
 * Tile layers that block movement.
 *
 * Furniture no longer blocks by being drawn, because furniture is no longer
 * drawn on the grid: a desk is a 128x96 sprite whose visible part is 61x44,
 * and treating the cell as the obstacle would wall off the room around it.
 * What a prop blocks is authored into `collision` by the map builder, which is
 * also the only thing that can decide you walk under a tree's canopy but not
 * through its trunk.
 */
export const COLLISION_LAYERS: readonly string[] = [LAYERS.walls, LAYERS.collision];

function propertyMap(properties?: TiledProperty[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const property of properties ?? []) result[property.name] = String(property.value);
  return result;
}

function tileLayers(map: TiledMap): TiledTileLayer[] {
  return map.layers.filter((layer): layer is TiledTileLayer => layer.type === 'tilelayer');
}

function objectLayer(map: TiledMap, name: string): TiledObjectLayer | undefined {
  return map.layers.find(
    (layer): layer is TiledObjectLayer => layer.type === 'objectgroup' && layer.name === name,
  );
}

/**
 * Build the walkability grid: a tile is walkable unless a collision layer has
 * something on it. This is the single definition of "can I stand here" — the
 * renderer, the pathfinder and (later) the server all read it, so a door that
 * looks open in Tiled is open everywhere.
 */
export function buildWalkableGrid(map: TiledMap): boolean[] {
  const size = map.width * map.height;
  const walkable = new Array<boolean>(size).fill(true);

  for (const layer of tileLayers(map)) {
    if (!COLLISION_LAYERS.includes(layer.name)) continue;
    for (let i = 0; i < size; i += 1) {
      if (layer.data[i] !== 0) walkable[i] = false;
    }
  }

  return walkable;
}

function parseZones(map: TiledMap): MapZone[] {
  const layer = objectLayer(map, LAYERS.zones);
  if (!layer) return [];

  const zones: MapZone[] = [];
  for (const object of layer.objects) {
    if (object.point) continue;
    const properties = propertyMap(object.properties);
    const kind = properties.kind;

    if (kind === undefined || !isZoneKind(kind)) {
      throw new Error(
        `Zone "${object.name}" (id ${object.id}) has kind "${kind ?? '<missing>'}" — expected ${ZONE_KINDS.join(' | ')}`,
      );
    }

    zones.push({
      id: properties.zoneId ?? `zone-${object.id}`,
      kind,
      label: properties.label ?? object.name,
      bounds: {
        x: Math.round(object.x / map.tilewidth),
        y: Math.round(object.y / map.tileheight),
        width: Math.round(object.width / map.tilewidth),
        height: Math.round(object.height / map.tileheight),
      },
    });
  }
  return zones;
}

function parseInteractables(map: TiledMap): MapInteractable[] {
  const layer = objectLayer(map, LAYERS.interactables);
  if (!layer) return [];

  const interactables: MapInteractable[] = [];
  for (const object of layer.objects) {
    if (object.point) continue;
    const properties = propertyMap(object.properties);
    const kind = properties.kind;

    // Same fail-loud contract as zones: a typo here would leave the board
    // hanging on the wall with nothing in front of it to stand on.
    if (kind === undefined || !isInteractableKind(kind)) {
      throw new Error(
        `Interactable "${object.name}" (id ${object.id}) has kind "${kind ?? '<missing>'}" — expected ${INTERACTABLE_KINDS.join(' | ')}`,
      );
    }

    interactables.push({
      id: properties.interactableId ?? `interactable-${object.id}`,
      kind,
      label: properties.label ?? object.name,
      bounds: {
        x: Math.round(object.x / map.tilewidth),
        y: Math.round(object.y / map.tileheight),
        width: Math.round(object.width / map.tilewidth),
        height: Math.round(object.height / map.tileheight),
      },
      prop: properties.prop ?? null,
      halo: haloOf(properties),
    });
  }
  return interactables;
}

function parseSeats(map: TiledMap): MapSeat[] {
  const layer = objectLayer(map, LAYERS.seats);
  if (!layer) return [];

  const seats: MapSeat[] = [];
  for (const object of layer.objects) {
    const properties = propertyMap(object.properties);
    const facing = properties.facing;
    // Fail loud, as zones and interactables do: a seat facing "nort" would
    // have an agent sitting with its back to its own desk.
    if (facing === undefined || !isDirection(facing)) {
      throw new Error(
        `Seat "${object.name}" (id ${object.id}) faces "${facing ?? '<missing>'}" — expected ${DIRECTIONS.join(' | ')}`,
      );
    }
    seats.push({
      id: properties.seatId ?? `seat-${object.id}`,
      // A point sits at the centre of its tile; a rectangle starts at its corner.
      tile: { x: Math.floor(object.x / map.tilewidth), y: Math.floor(object.y / map.tileheight) },
      facing,
      screen: rectOf(properties, ['screenX', 'screenY', 'screenWidth', 'screenHeight']),
    });
  }
  return seats;
}

/** The four `halo*` ints, or null if any is missing or not a number. */
function haloOf(properties: Record<string, string>): MapInteractable['halo'] {
  return rectOf(properties, ['haloX', 'haloY', 'haloWidth', 'haloHeight']);
}

/** Four int properties as a rectangle, or null if any is missing or not a number. */
function rectOf(properties: Record<string, string>, names: readonly string[]): PixelRect | null {
  const values = names.map((name) => {
    const raw = properties[name];
    return raw === undefined ? Number.NaN : Number(raw);
  });
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, width, height] = values as [number, number, number, number];
  return { x, y, width, height };
}

function isPlayerKind(value: string): value is PlayerKind {
  return value === 'human' || value === 'agent';
}

function parseSpawns(map: TiledMap): SpawnPoint[] {
  const layer = objectLayer(map, LAYERS.spawns);
  if (!layer) return [];

  return layer.objects.map((object) => {
    const properties = propertyMap(object.properties);
    const kind = properties.kind;

    // Same fail-loud contract as zones: defaulting an unknown value to "human"
    // would turn a typo in Tiled into agents quietly losing their spawn points.
    if (kind === undefined || !isPlayerKind(kind)) {
      throw new Error(
        `Spawn "${object.name}" (id ${object.id}) has kind "${kind ?? '<missing>'}" — expected human | agent`,
      );
    }

    return {
      name: object.name,
      kind,
      // Point objects sit at the centre of a tile.
      x: Math.floor(object.x / map.tilewidth),
      y: Math.floor(object.y / map.tileheight),
    };
  });
}

/** Turn a raw Tiled map into the model the game and the server share. */
export function parseTiledMap(raw: TiledMap): OfficeMap {
  if (raw.tilewidth !== raw.tileheight) {
    throw new Error(`Non-square tiles (${raw.tilewidth}x${raw.tileheight}) are not supported`);
  }

  const seats = parseSeats(raw);
  const walkable = buildWalkableGrid(raw);
  // A chair is nobody's to stand on until the office gives it to somebody:
  // `withSeatOpen` is how one is opened, for one agent, for one route.
  for (const seat of seats) {
    const { x, y } = seat.tile;
    if (x >= 0 && y >= 0 && x < raw.width && y < raw.height) walkable[y * raw.width + x] = false;
  }

  return {
    name: propertyMap(raw.properties).name ?? 'Office',
    width: raw.width,
    height: raw.height,
    tileSize: raw.tilewidth,
    zones: parseZones(raw),
    interactables: parseInteractables(raw),
    seats,
    spawns: parseSpawns(raw),
    walkable,
  };
}
