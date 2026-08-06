import {
  isZoneKind,
  type MapZone,
  type OfficeMap,
  type SpawnPoint,
} from '../map.js';
import type { PlayerKind } from '../player.js';

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
  furniture: 'furniture',
  decor: 'decor',
  spawns: 'spawns',
  zones: 'zones',
} as const;

/** Tile layers that block movement. `decor` deliberately does not. */
export const COLLISION_LAYERS: readonly string[] = [LAYERS.walls, LAYERS.furniture];

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
        `Zone "${object.name}" (id ${object.id}) has kind "${kind ?? '<missing>'}" — expected private | spawn | agent_area`,
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

function parseSpawns(map: TiledMap): SpawnPoint[] {
  const layer = objectLayer(map, LAYERS.spawns);
  if (!layer) return [];

  return layer.objects.map((object) => {
    const properties = propertyMap(object.properties);
    const kind: PlayerKind = properties.kind === 'agent' ? 'agent' : 'human';
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

  return {
    name: propertyMap(raw.properties).name ?? 'Office',
    width: raw.width,
    height: raw.height,
    tileSize: raw.tilewidth,
    zones: parseZones(raw),
    spawns: parseSpawns(raw),
    walkable: buildWalkableGrid(raw),
  };
}
