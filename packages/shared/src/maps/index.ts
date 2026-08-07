import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTiledMap, type TiledMap } from '../game/tiled.js';
import type { OfficeMap } from '../map.js';

/**
 * Loads maps from disk. Node only — the browser gets the same files over HTTP
 * (see `apps/web/scripts/sync-map.mjs`), which is why this is a separate entry
 * point from `@quintal/shared` rather than part of the main surface.
 *
 * The point of both sides reading the *same* file is that the walkability grid
 * the server simulates against is the grid the client predicts against. A map
 * the two disagree about is a map where players walk through walls on one
 * screen and bounce off them on the other.
 */

/** `packages/shared` — identical depth whether running from `src/` or `dist/`. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const MAPS_DIR = join(PACKAGE_ROOT, 'maps');

/** Maps that ship with Quintal. Room ids are keyed by these. */
export const MAP_IDS = ['hq'] as const;
export type MapId = (typeof MAP_IDS)[number];

export function isMapId(value: string): value is MapId {
  return (MAP_IDS as readonly string[]).includes(value);
}

const cache = new Map<string, OfficeMap>();

/**
 * Read and parse a map, memoised. Maps are static at runtime; re-reading and
 * re-deriving the walkability grid on every room creation would be waste.
 */
export function loadOfficeMap(mapId: string): OfficeMap {
  const cached = cache.get(mapId);
  if (cached) return cached;

  if (!isMapId(mapId)) {
    throw new Error(`Unknown map "${mapId}" — expected one of: ${MAP_IDS.join(', ')}`);
  }

  const raw = JSON.parse(readFileSync(join(MAPS_DIR, `${mapId}.json`), 'utf8')) as TiledMap;
  const map = parseTiledMap(raw);
  cache.set(mapId, map);
  return map;
}
