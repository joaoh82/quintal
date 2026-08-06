#!/usr/bin/env node
/**
 * Copies the shared Tiled maps into `public/` so Phaser's loader can fetch them
 * over HTTP.
 *
 * The maps live in `packages/shared/maps` because the game server will read the
 * same files straight off disk — one map, one source of truth, no divergence
 * between what you walk around in and what the server simulates. The browser
 * can't read that directory, hence this copy. It runs from `dev` and `build`,
 * and the copies are git-ignored.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(WEB_ROOT, '../../packages/shared/maps');
const TARGET = resolve(WEB_ROOT, 'public/assets/maps');

mkdirSync(TARGET, { recursive: true });

const maps = readdirSync(SOURCE).filter((file) => file.endsWith('.json'));
for (const map of maps) {
  copyFileSync(join(SOURCE, map), join(TARGET, map));
}

console.log(`[sync-map] ${maps.length} map(s) -> public/assets/maps`);
