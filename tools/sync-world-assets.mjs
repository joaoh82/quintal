#!/usr/bin/env node
/**
 * Copies the Shared World asset pack into `apps/web/public/assets/world`.
 *
 * The pack is authored outside this repo (it is an art library, not code) and
 * ships far more than a game needs: per-frame PNGs, animated GIF previews,
 * contact sheets, the generated source images. Vendoring the whole thing would
 * put 35MB of preview material in git for the ~1MB the browser actually loads.
 *
 * So this script copies exactly the files the renderer asks for, and nothing
 * else. Run it when the pack changes; the copies are committed, so a normal
 * build never needs the pack to be present.
 *
 *   node tools/sync-world-assets.mjs [path-to-pack]
 *
 * The path defaults to $QUINTAL_WORLD_PACK, then to the author's Dropbox copy.
 * Provenance and licensing live in apps/web/public/assets/CREDITS.md.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(REPO_ROOT, 'apps/web/public/assets/world');

const PACK =
  process.argv[2] ??
  process.env.QUINTAL_WORLD_PACK ??
  join(process.env.HOME ?? '', 'Dropbox/projects/quintal/shared-world-assets-v1');

/** Twelve bodies, in the pack's own order. Keep in sync with `@quintal/shared`. */
const AVATARS = [
  'aria', 'milo', 'sora', 'nadia', 'theo', 'imani',
  'hugo', 'priya', 'luca', 'mei', 'sam', 'rosa',
];

/**
 * Prop atlases. Frame names collide across environments (three of them have a
 * `chair-north`), so the renderer namespaces them by atlas key — `meeting/chair-north`.
 */
const ATLASES = [
  { key: 'office-base', png: 'environments/office/base/office-props.png', json: 'environments/office/base/office-props.json' },
  { key: 'office', png: 'environments/office/office-extra.png', json: 'environments/office/office-extra.json' },
  { key: 'meeting', png: 'environments/meeting/props.png', json: 'environments/meeting/props.json' },
  { key: 'cafeteria', png: 'environments/cafeteria/props.png', json: 'environments/cafeteria/props.json' },
  { key: 'hallway', png: 'environments/hallway/props.png', json: 'environments/hallway/props.json' },
  { key: 'garden', png: 'environments/garden/props.png', json: 'environments/garden/props.json' },
];

const PLAIN = [
  ['shared/terrain/surfaces.png', 'terrain/surfaces.png'],
  ['shared/walls/walls.png', 'walls/walls.png'],
];

function copy(from, to) {
  const target = join(TARGET, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(PACK, from), target);
}

let copied = 0;

for (const [from, to] of PLAIN) {
  copy(from, to);
  copied += 1;
}

for (const atlas of ATLASES) {
  copy(atlas.png, `props/${atlas.key}.png`);
  // The pack's atlas JSON points at its own filename; ours is renamed per
  // environment, and Phaser reads `meta.image` when the loader is given a
  // directory-relative atlas. Rewrite it rather than rely on load order.
  const json = JSON.parse(readFileSync(join(PACK, atlas.json), 'utf8'));
  json.meta.image = `${atlas.key}.png`;
  mkdirSync(join(TARGET, 'props'), { recursive: true });
  writeFileSync(join(TARGET, `props/${atlas.key}.json`), `${JSON.stringify(json)}\n`);
  copied += 2;
}

for (const id of AVATARS) {
  // Sheets are a plain 8x4 grid of 32x48 frames, identical for every body, so
  // the renderer indexes them directly and the pack's per-avatar atlas JSON is
  // not needed. See AVATAR_SHEET in apps/web/src/game/constants.ts.
  copy(`avatars/${id}/sheet.png`, `avatars/${id}.png`);
  copied += 1;
}

/**
 * Visible bounds per prop, for the map builder's collision footprints.
 *
 * The pack's own advice is that a 128x96 cell must never become a 128x96
 * obstacle, so the builder sizes footprints from what a prop actually covers.
 * `asset-manifest.json` records that for the new props; the sixteen retained
 * 64x64 office props predate the field, so their bounds are measured here.
 */
const BASE_PROP_BOUNDS = {
  bookcase: [40, 59], 'chair-east': [21, 32], 'chair-north': [25, 30], 'chair-south': [24, 32],
  'coffee-station': [54, 53], 'coffee-table': [45, 32], 'desk-computer': [62, 44], 'desk-empty': [62, 40],
  'filing-cabinet': [26, 40], 'meeting-table': [52, 52], 'plant-small': [33, 32], 'plant-tall': [28, 44],
  sofa: [62, 42], 'water-cooler': [19, 52], whiteboard: [54, 48], window: [60, 39],
};

/** Which atlas a manifest entry belongs to, from its path in the pack. */
const ATLAS_OF_PATH = new Map(
  ATLASES.map((atlas) => [atlas.png.split('/').slice(0, -1).join('/'), atlas.key]),
);

const manifest = JSON.parse(readFileSync(join(PACK, 'asset-manifest.json'), 'utf8'));
const sizes = {};
for (const prop of manifest.newProps) {
  const key = ATLAS_OF_PATH.get(prop.file.replace('/individual/', '/').split('/').slice(0, -1).join('/'));
  if (!key) continue;
  sizes[`${key}/${prop.name}`] = prop.visibleSize;
}
for (const [name, size] of Object.entries(BASE_PROP_BOUNDS)) sizes[`office-base/${name}`] = size;

writeFileSync(
  join(REPO_ROOT, 'tools/world-prop-sizes.json'),
  `${JSON.stringify(sizes, null, 2)}\n`,
);
copied += 1;

/**
 * The art contract, copied in so it is reviewable next to the code that
 * consumes it. Anyone drawing a new prop needs the anchors, the palette ramps
 * and the projection rules, and "they are in a folder on somebody's Dropbox"
 * is not a contract anybody can follow.
 */
const guidelines = readFileSync(join(PACK, 'DESIGN_GUIDELINES.md'), 'utf8');
writeFileSync(
  join(REPO_ROOT, 'docs/world-assets.md'),
  '<!-- Copied verbatim from the Shared World pack by tools/sync-world-assets.mjs.\n' +
    '     Edit it in the pack and re-run the script; edits here are overwritten. -->\n\n' +
    guidelines,
);
copied += 1;

console.log(`[sync-world-assets] ${copied} file(s) from ${PACK} -> apps/web/public/assets/world`);
