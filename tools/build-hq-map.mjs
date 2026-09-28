#!/usr/bin/env node
/**
 * Builds `packages/shared/maps/hq.json`.
 *
 * The old HQ was four flat tile layers of 16x16 Kenney tiles, small enough to
 * hand-edit in Tiled. The new one is not: props are anchored sprites rather
 * than grid cells, walls are a computed connection family, and collision is
 * authored per prop rather than "anything on the furniture layer". Placing
 * three hundred anchored objects by hand and keeping the derived wall and
 * collision layers consistent with them is work a script should do.
 *
 * The output is still ordinary Tiled JSON and still opens in Tiled. If you ever
 * want to take the map over by hand, edit the JSON and stop running this — but
 * then delete this script, because two sources of truth for one map is how a
 * floor plan and its collision grid drift apart.
 *
 *   node tools/build-hq-map.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'packages/shared/maps/hq.json');
const PROP_SIZES = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/world-prop-sizes.json'), 'utf8'));

const TILE = 32;
const W = 56;
const H = 46;

// --- terrain -----------------------------------------------------------------

/** Row-major order of `shared/terrain/surfaces.png`. */
const SURFACES = [
  'grass', 'grass-dark', 'gravel', 'stone-pavers',
  'ceramic-ivory', 'ceramic-terracotta', 'terrazzo', 'entrance-carpet',
  'carpet-teal', 'carpet-blue', 'wood-light', 'wood-warm',
  'cobblestone', 'soil', 'water', 'patio',
];
const SURFACE_FIRSTGID = 1;
const WALL_FIRSTGID = SURFACE_FIRSTGID + SURFACES.length;

const surfaceGid = (name) => {
  const index = SURFACES.indexOf(name);
  if (index < 0) throw new Error(`Unknown surface "${name}"`);
  return SURFACE_FIRSTGID + index;
};

// --- the grid ----------------------------------------------------------------

const floor = new Array(W * H).fill(surfaceGid('ceramic-ivory'));
const wall = new Array(W * H).fill(false);
const blocked = new Array(W * H).fill(false);
const props = [];

const at = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

function paint(x0, y0, x1, y1, surface) {
  const gid = surfaceGid(surface);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (inside(x, y)) floor[at(x, y)] = gid;
    }
  }
}

function wallRow(y, x0, x1) {
  for (let x = x0; x <= x1; x += 1) if (inside(x, y)) wall[at(x, y)] = true;
}

function wallColumn(x, y0, y1) {
  for (let y = y0; y <= y1; y += 1) if (inside(x, y)) wall[at(x, y)] = true;
}

function doorway(x, y) {
  wall[at(x, y)] = false;
}

/**
 * Footprints a prop actually blocks.
 *
 * Derived from visible bounds rather than the 128x96 cell, because the cell is
 * mostly padding — the asset guidelines are explicit that treating it as an
 * obstacle is wrong. A tile counts as blocked when the prop covers enough of it
 * to be worth walking around; the threshold keeps a 21px chair out of its
 * neighbours while still stopping a 60px fence in both tiles it spans.
 *
 * Overrides carry the judgement calls a rule cannot make: what is scenery you
 * pass under (a tree's canopy, a plant's leaves), what sits on a surface, and
 * what hangs on a wall that already blocks.
 */
const COVERAGE = 0.35;

const NO_COLLISION = new Set([
  // On a desk or table.
  'office/desk-lamp', 'office/laptop', 'office/telephone', 'office/paper-tray',
  'meeting/speakerphone', 'meeting/notebook', 'meeting/laptop', 'meeting/water-set',
  'cafeteria/fruit-bowl', 'cafeteria/meal-tray',
  // On a wall, which is already solid.
  'office-base/window', 'hallway/noticeboard', 'hallway/artwork', 'hallway/clock',
  'hallway/direction-sign', 'hallway/emergency-cabinet', 'hallway/coat-hooks',
  'hallway/glass-doors-closed', 'hallway/door-closed', 'meeting/acoustic-panel',
  // In a doorway you are meant to walk through.
  'hallway/door-open', 'hallway/glass-doors-open',
  // On the floor.
  'hallway/entrance-mat',
]);

/** Blocks less than its silhouette: you walk past the base, not the canopy. */
const FOOTPRINTS = {
  'garden/tree': [2, 1],
  'garden/flowering-tree': [2, 1],
  'garden/lamppost': [1, 1],
  'office-base/plant-tall': [1, 1],
  'hallway/plant-tall': [1, 1],
  'hallway/elevator': [1, 2],
};

function blockFor(sprite, ax, ay) {
  if (NO_COLLISION.has(sprite)) return;

  const fixed = FOOTPRINTS[sprite];
  if (fixed) {
    const [tw, th] = fixed;
    const left = Math.round(ax / TILE - tw / 2);
    const bottom = Math.ceil(ay / TILE) - 1;
    for (let y = bottom - th + 1; y <= bottom; y += 1) {
      for (let x = left; x < left + tw; x += 1) if (inside(x, y)) blocked[at(x, y)] = true;
    }
    return;
  }

  const size = PROP_SIZES[sprite];
  if (!size) throw new Error(`No visible size recorded for "${sprite}"`);
  const [vw, vh] = size;
  const left = ax - vw / 2;
  const right = ax + vw / 2;
  const top = ay - vh;

  for (let y = Math.floor(top / TILE); y <= Math.floor((ay - 1) / TILE); y += 1) {
    for (let x = Math.floor(left / TILE); x <= Math.floor((right - 1) / TILE); x += 1) {
      if (!inside(x, y)) continue;
      const overlapX = Math.min(right, (x + 1) * TILE) - Math.max(left, x * TILE);
      const overlapY = Math.min(ay, (y + 1) * TILE) - Math.max(top, y * TILE);
      if (overlapX <= 0 || overlapY <= 0) continue;
      if ((overlapX * overlapY) / (TILE * TILE) >= COVERAGE) blocked[at(x, y)] = true;
    }
  }
}

/**
 * Place a prop. `tx`/`ty` are tiles and may be fractional: a two-tile-wide desk
 * sits on `x.5` so it lands on the boundary between two tiles rather than
 * straddling three.
 *
 * The anchor is the prop's ground point — the bottom of what it stands on —
 * which is both where it is drawn from and what it sorts by, so a person
 * walking south of a bookcase passes in front of it.
 */
function prop(sprite, tx, ty, options = {}) {
  const ax = Math.round(tx * TILE + TILE / 2);
  const ay = Math.round(ty * TILE + TILE) + (options.lift ?? 0);
  props.push({ sprite, x: ax, y: ay, ...(options.z === undefined ? {} : { z: options.z }) });
  blockFor(sprite, ax, ay);
}

/**
 * A door standing in a doorway.
 *
 * Two things are wrong if a door is placed like ordinary furniture. Its sprite
 * is taller than the wall row it fills, so it has to be lifted to sit in the
 * gap rather than below it; and it would then sort in front of anybody
 * standing next to it, so somebody in the room behind would be hidden by their
 * own door. Pinning the depth a row above the opening puts the door in the
 * wall, where it belongs, and everybody who walks near it in front.
 */
function door(sprite, tx, ty, lift) {
  prop(sprite, tx, ty, { lift, z: (ty - 1) * TILE });
}

/** A run of the same prop, every `step` tiles. */
function row(sprite, tx, ty, count, step = 1, options = {}) {
  for (let i = 0; i < count; i += 1) prop(sprite, tx + i * step, ty, options);
}

// --- floor plan --------------------------------------------------------------
//
//  y0          outer wall
//  y1..10      three meeting rooms, split at x18 and x36
//  y11         wall, with a doorway into each room
//  y12..16     hallway spine, reception west, lift east
//  y17         wall, with doorways to the office and the cafeteria
//  y18..27     open office (west), cafeteria (east of x38)
//  y28..33     agent bay, the full width of the building
//  y34         outer wall, with glass doors to the garden
//  y35..45     garden
//
// The bay runs wall to wall rather than sitting under the office, because it
// is the thing the product is about: a fleet of agents should read as a floor
// of the building, not a corner of somebody else's room.

const ROOMS = {
  huddle: { x0: 1, y0: 1, x1: 17, y1: 10 },
  focus: { x0: 19, y0: 1, x1: 35, y1: 10 },
  deepWork: { x0: 37, y0: 1, x1: 54, y1: 10 },
  hall: { x0: 1, y0: 12, x1: 54, y1: 16 },
  office: { x0: 1, y0: 18, x1: 37, y1: 27 },
  cafe: { x0: 39, y0: 18, x1: 54, y1: 27 },
  bay: { x0: 1, y0: 28, x1: 54, y1: 33 },
  garden: { x0: 0, y0: 35, x1: 55, y1: 45 },
};

function shell() {
  wallRow(0, 0, W - 1);
  wallRow(34, 0, W - 1);
  wallColumn(0, 0, 34);
  wallColumn(W - 1, 0, 34);

  wallRow(11, 0, W - 1);
  wallRow(17, 0, W - 1);
  wallColumn(18, 1, 10);
  wallColumn(36, 1, 10);
  wallColumn(38, 18, 27);

  // Doorways. Every room reaches the hallway; the office also opens straight
  // into the cafeteria, because walking back out to the corridor for coffee is
  // the kind of realism nobody enjoys.
  for (const x of [9, 27, 45]) doorway(x, 11);
  for (const x of [12, 26, 46]) doorway(x, 17);
  doorway(38, 24);
  doorway(19, 34);
  doorway(20, 34);
}

function floors() {
  paint(0, 0, W - 1, 34, 'ceramic-ivory');
  paint(ROOMS.huddle.x0, ROOMS.huddle.y0, ROOMS.huddle.x1, ROOMS.huddle.y1, 'carpet-teal');
  paint(ROOMS.focus.x0, ROOMS.focus.y0, ROOMS.focus.x1, ROOMS.focus.y1, 'carpet-teal');
  paint(ROOMS.deepWork.x0, ROOMS.deepWork.y0, ROOMS.deepWork.x1, ROOMS.deepWork.y1, 'carpet-blue');

  paint(ROOMS.hall.x0, ROOMS.hall.y0, ROOMS.hall.x1, ROOMS.hall.y1, 'terrazzo');
  paint(3, 13, 52, 15, 'entrance-carpet');

  paint(ROOMS.office.x0, ROOMS.office.y0, ROOMS.office.x1, ROOMS.office.y1, 'carpet-blue');
  paint(30, 18, 37, 27, 'wood-light');

  paint(ROOMS.cafe.x0, ROOMS.cafe.y0, ROOMS.cafe.x1, ROOMS.cafe.y1, 'ceramic-ivory');
  paint(39, 18, 54, 20, 'ceramic-terracotta');
  paint(39, 27, 54, 27, 'wood-warm');

  paint(ROOMS.bay.x0, ROOMS.bay.y0, ROOMS.bay.x1, ROOMS.bay.y1, 'terrazzo');

  // Outside. Paths meet at a paved square with the fountain in it.
  paint(0, 35, W - 1, H - 1, 'grass');
  paint(0, 38, W - 1, 39, 'stone-pavers');
  paint(18, 35, 21, H - 1, 'stone-pavers');
  paint(15, 36, 25, 42, 'patio');
  paint(4, 43, 10, 45, 'cobblestone');
  paint(44, 35, 48, 37, 'soil');
}

// --- rooms -------------------------------------------------------------------

function huddleRoom() {
  prop('meeting/oval-table', 9, 6);
  row('meeting/chair-south', 8, 4, 3);
  row('meeting/chair-north', 8, 7, 3);
  prop('meeting/chair-west', 11, 6);
  prop('meeting/chair-east', 7, 6);
  prop('meeting/laptop', 8.5, 5, { lift: -18 });
  prop('meeting/water-set', 10, 5, { lift: -18 });
  prop('meeting/speakerphone', 9, 5, { lift: -16 });

  prop('meeting/presentation-screen', 9, 2);
  prop('meeting/flipchart', 15, 3);
  prop('meeting/side-table', 15, 9);
  prop('office-base/plant-tall', 16, 2);
  prop('meeting/acoustic-panel', 3, 1, { z: 12 });
  prop('meeting/acoustic-panel', 5, 1, { z: 12 });
  prop('office-base/window', 12, 1, { z: 12 });
  prop('office-base/window', 14.5, 1, { z: 12 });
  door('hallway/door-open', 9, 11, -22);
}

function focusRoom() {
  prop('meeting/boardroom-table', 27, 6);
  row('meeting/chair-south', 25, 4, 5);
  row('meeting/chair-north', 25, 7, 5);
  prop('meeting/chair-west', 29.5, 6);
  prop('meeting/chair-east', 24.5, 6);
  prop('meeting/notebook', 26, 5, { lift: -20 });
  prop('meeting/laptop', 28.5, 5, { lift: -20 });
  prop('meeting/water-set', 27, 5, { lift: -18 });

  prop('meeting/presentation-screen', 27, 2);
  prop('meeting/media-cabinet', 21, 3);
  prop('meeting/whiteboard', 33, 4);
  prop('office-base/plant-tall', 34, 9);
  prop('meeting/acoustic-panel', 20, 1, { z: 12 });
  prop('meeting/acoustic-panel', 22, 1, { z: 12 });
  prop('office-base/window', 30.5, 1, { z: 12 });
  prop('office-base/window', 33, 1, { z: 12 });
  door('hallway/door-open', 27, 11, -22);
}

/** Heads-down desks rather than a table: the room is for working, not meeting. */
function deepWorkRoom() {
  for (const ty of [4, 9]) {
    row('office/desk-north', 39.5, ty, 4, 4);
    row('office-base/chair-north', 39.5, ty + 1, 4, 4);
  }
  row('office/divider-horizontal', 39.5, 6, 4, 4);
  prop('office-base/bookcase', 53, 3);
  prop('office-base/bookcase', 53, 6);
  prop('office-base/water-cooler', 38, 10);
  prop('office-base/plant-tall', 53, 10);
  prop('office/desk-lamp', 38.5, 3, { lift: -26 });
  prop('office/desk-lamp', 46.5, 8, { lift: -26 });
  prop('office-base/window', 40.5, 1, { z: 12 });
  prop('office-base/window', 44, 1, { z: 12 });
  prop('office-base/window', 47.5, 1, { z: 12 });
  door('hallway/door-open', 45, 11, -22);
}

function hallway() {
  prop('hallway/glass-doors-closed', 0, 14, { z: 12 });
  prop('hallway/entrance-mat', 2, 14, { z: 2 });
  prop('office/reception-counter', 5.5, 15);
  prop('office/chair-west', 5.5, 13);
  prop('office/telephone', 4.5, 15, { lift: -26 });
  prop('office/coat-stand', 2, 16);

  prop('hallway/waiting-bench', 15.5, 16);
  prop('hallway/waiting-bench', 21.5, 16);
  prop('hallway/plant-trough', 18.5, 16);
  prop('hallway/plant-tall', 12, 12);
  prop('hallway/plant-tall', 33, 16);
  prop('hallway/waiting-bench', 39.5, 16);
  prop('hallway/plant-trough', 28.5, 12);
  prop('hallway/artwork', 16, 12, { z: 12 });
  prop('hallway/drinking-fountain', 30, 12);

  prop('hallway/elevator', 54, 14);
  prop('hallway/direction-sign', 50, 12, { z: 12 });
  prop('hallway/noticeboard', 23, 12, { z: 12 });
  prop('hallway/artwork', 7, 12, { z: 12 });
  prop('hallway/clock', 28, 12, { z: 12 });
  prop('hallway/emergency-cabinet', 43, 12, { z: 12 });
  prop('hallway/coat-hooks', 36, 12, { z: 12 });
  door('hallway/door-open', 12, 17, -22);
  door('hallway/door-open', 26, 17, -22);
  door('hallway/door-open', 46, 17, -22);
}

function openOffice() {
  for (const ty of [20, 24]) {
    row('office-base/desk-computer', 3.5, ty, 5, 6);
    row('office-base/chair-north', 3.5, ty + 1, 5, 6);
  }
  row('office/divider-horizontal', 3.5, 22, 5, 6);
  prop('office/printer-cabinet', 1.5, 18);
  prop('office-base/filing-cabinet', 28, 18);
  prop('office-base/coffee-station', 28.5, 27);
  prop('office/paper-tray', 9.5, 20, { lift: -34 });
  prop('office/telephone', 21.5, 20, { lift: -34 });
  prop('office/desk-lamp', 15.5, 24, { lift: -34 });

  // The lounge, on wood rather than carpet so it reads as somewhere else.
  prop('office-base/sofa', 33.5, 20);
  prop('office-base/coffee-table', 33.5, 22);
  prop('office-base/plant-tall', 31, 19);
  prop('office-base/plant-small', 36, 26);
  prop('office-base/bookcase', 31, 25);
  prop('office-base/meeting-table', 34, 26);
  prop('office-base/chair-south', 34, 25);
  prop('office/divider-vertical', 29, 20);
  prop('office/divider-vertical', 29, 22);
  prop('office/divider-vertical', 29, 24);
}

function agentBay() {
  row('office/desk-south', 4.5, 30, 10, 5);
  row('office-base/chair-north', 4.5, 31, 10, 5);
  row('office/laptop', 4.5, 30, 10, 5, { lift: -34 });
  prop('office/server-cabinet', 2, 33);
  prop('office/server-cabinet', 4, 33);
  prop('office/server-cabinet', 52, 33);
  prop('office/server-cabinet', 54, 33);
  prop('office/storage-cabinet', 49.5, 33);
  prop('office-base/whiteboard', 15, 33);
  prop('office-base/whiteboard', 40, 33);
  prop('office-base/plant-tall', 1, 28);
  prop('office-base/plant-tall', 54, 28);
  prop('office-base/water-cooler', 27, 28);
}

function cafeteria() {
  prop('cafeteria/serving-counter', 42.5, 20);
  prop('cafeteria/coffee-counter', 46.5, 20);
  prop('cafeteria/sink-counter', 50, 20);
  prop('cafeteria/drinks-fridge', 40, 19);
  prop('cafeteria/microwave-cabinet', 53, 19);
  prop('cafeteria/vending-machine', 54, 22);

  for (const ty of [23, 26]) {
    prop('cafeteria/dining-table', 42.5, ty);
    prop('cafeteria/dining-table', 48.5, ty);
    row('cafeteria/chair-south', 41.5, ty - 1, 2, 2);
    row('cafeteria/chair-north', 41.5, ty + 1, 2, 2);
    row('cafeteria/chair-south', 47.5, ty - 1, 2, 2);
    row('cafeteria/chair-north', 47.5, ty + 1, 2, 2);
  }
  prop('cafeteria/meal-tray', 42, 23, { lift: -30 });
  prop('cafeteria/fruit-bowl', 48.5, 23, { lift: -30 });
  prop('cafeteria/square-table', 51, 24);
  prop('cafeteria/chair-west', 52, 24);
  prop('cafeteria/dish-trolley', 40, 25);
  prop('cafeteria/recycling-station', 52.5, 27);
  prop('office-base/plant-tall', 39, 22);
}

function garden() {
  door('hallway/glass-doors-open', 19.5, 34, 0);

  prop('garden/fountain', 19.5, 40);
  prop('garden/bench-north', 16.5, 37);
  prop('garden/bench-north', 23.5, 37);
  prop('garden/bench-south', 16.5, 43);
  prop('garden/bench-south', 23.5, 43);
  prop('garden/bench-east', 14, 40);
  prop('garden/bench-west', 26, 40);
  prop('garden/lamppost', 14, 37);
  prop('garden/lamppost', 26, 37);
  prop('garden/lamppost', 14, 43);
  prop('garden/lamppost', 26, 43);

  row('garden/tree', 4.5, 37, 3, 5);
  row('garden/flowering-tree', 7, 43, 2, 5);
  row('garden/tree', 33.5, 37, 4, 5);
  row('garden/flowering-tree', 36, 44, 3, 6);
  row('garden/shrub', 30, 41, 3, 2);
  prop('garden/rocks', 11.5, 45);
  prop('garden/rocks', 51.5, 41);

  prop('garden/flowerbed', 45.5, 36);
  prop('garden/flowerbed', 48.5, 36);
  prop('garden/flowerbed', 45.5, 37);
  prop('garden/flowerbed', 48.5, 37);
  prop('garden/fern-planter', 43, 40);
  prop('garden/fern-planter', 52, 36);

  prop('garden/garden-table', 6.5, 44);
  prop('garden/garden-table', 10.5, 44);
  prop('garden/outdoor-bin', 22, 36);
  prop('garden/outdoor-bin', 42, 44);

  // A fence around the outside, so the garden ends somewhere you can see.
  row('garden/fence-horizontal', 0.5, 45, 28, 2);
  for (let y = 35; y <= 45; y += 1) {
    prop('garden/fence-vertical', 0, y);
    prop('garden/fence-vertical', 55, y);
  }
}

// --- zones and spawns --------------------------------------------------------

const rect = (room) => ({
  x: room.x0,
  y: room.y0,
  width: room.x1 - room.x0 + 1,
  height: room.y1 - room.y0 + 1,
});

/**
 * Order matters: `zoneAt` lets a later zone win an overlap, which is how the
 * lobby sits inside the hallway without the hallway having a hole in it.
 */
const ZONES = [
  { id: 'huddle', kind: 'private', label: 'Huddle Room', bounds: rect(ROOMS.huddle) },
  { id: 'focus', kind: 'private', label: 'Focus Room', bounds: rect(ROOMS.focus) },
  { id: 'deep-work', kind: 'private', label: 'Deep Work', bounds: rect(ROOMS.deepWork) },
  { id: 'hallway', kind: 'common', label: 'Hallway', bounds: rect(ROOMS.hall) },
  { id: 'lobby', kind: 'spawn', label: 'Lobby', bounds: { x: 13, y: 12, width: 12, height: 5 } },
  { id: 'office', kind: 'common', label: 'Open Office', bounds: rect(ROOMS.office) },
  { id: 'agent-bay', kind: 'agent_area', label: 'Agent Bay', bounds: rect(ROOMS.bay) },
  { id: 'cafeteria', kind: 'common', label: 'Cafeteria', bounds: rect(ROOMS.cafe) },
  { id: 'garden', kind: 'common', label: 'Garden', bounds: rect(ROOMS.garden) },
];

const SPAWNS = [
  ...[16, 18, 20, 22].map((x, i) => ({ name: `human-${i + 1}`, kind: 'human', x, y: 14 })),
  ...[6, 13, 20, 27, 34, 41, 48].map((x, i) => ({ name: `agent-${i + 1}`, kind: 'agent', x, y: 32 })),
];

// --- build -------------------------------------------------------------------

shell();
floors();
huddleRoom();
focusRoom();
deepWorkRoom();
hallway();
openOffice();
agentBay();
cafeteria();
garden();

/** Cardinal connection index: north 1, east 2, south 4, west 8. */
function wallGid(x, y) {
  const on = (dx, dy) => (inside(x + dx, y + dy) ? wall[at(x + dx, y + dy)] : false);
  const mask = (on(0, -1) ? 1 : 0) + (on(1, 0) ? 2 : 0) + (on(0, 1) ? 4 : 0) + (on(-1, 0) ? 8 : 0);
  return WALL_FIRSTGID + mask;
}

const wallLayer = new Array(W * H).fill(0);
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    if (wall[at(x, y)]) wallLayer[at(x, y)] = wallGid(x, y);
  }
}

// Props may have dropped collision onto a wall or a doorway; walls already
// block, and a doorway that a door sprite closed would seal a room.
const collisionLayer = new Array(W * H).fill(0);
for (let i = 0; i < W * H; i += 1) {
  if (blocked[i] && !wall[i]) collisionLayer[i] = WALL_FIRSTGID;
}

// --- checks ------------------------------------------------------------------
//
// The whole point of generating the map is that the floor plan and the grid
// you can walk on cannot drift. These assertions are what makes that true: a
// desk nudged two tiles left that seals the cafeteria fails the build instead
// of shipping.

const walkable = (x, y) =>
  inside(x, y) && !wall[at(x, y)] && collisionLayer[at(x, y)] === 0;

function reachable(from) {
  const seen = new Set();
  const queue = [from];
  seen.add(`${from.x},${from.y}`);
  while (queue.length > 0) {
    const tile = queue.pop();
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const next = { x: tile.x + dx, y: tile.y + dy };
      const key = `${next.x},${next.y}`;
      if (seen.has(key) || !walkable(next.x, next.y)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return seen;
}

const problems = [];

for (const spawn of SPAWNS) {
  if (!walkable(spawn.x, spawn.y)) problems.push(`spawn ${spawn.name} is blocked`);
}

const start = SPAWNS.find((spawn) => spawn.kind === 'human');
const seen = reachable({ x: start.x, y: start.y });

/**
 * Nowhere you can stand but cannot reach.
 *
 * A pocket of floor sealed in by furniture is not a cosmetic problem: click
 * it and `nearestWalkable` routes you to a tile A* cannot get to, so the
 * click does nothing and the office looks broken. Two of these survived the
 * first build — one behind a vending machine, one between two garden tables —
 * and only turned up when somebody flood-filled the map by hand.
 */
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    if (!walkable(x, y) || seen.has(`${x},${y}`)) continue;
    problems.push(`tile ${x},${y} can be stood on but not walked to`);
  }
}

for (const zone of ZONES) {
  const { x, y, width, height } = zone.bounds;
  let open = 0;
  let reached = 0;
  for (let ty = y; ty < y + height; ty += 1) {
    for (let tx = x; tx < x + width; tx += 1) {
      if (!walkable(tx, ty)) continue;
      open += 1;
      if (seen.has(`${tx},${ty}`)) reached += 1;
    }
  }
  if (open === 0) problems.push(`zone ${zone.id} has no walkable tile`);
  else if (reached === 0) problems.push(`zone ${zone.id} cannot be reached from the lobby`);
  else if (reached < open * 0.5) {
    problems.push(`zone ${zone.id}: only ${reached} of ${open} open tiles are reachable`);
  }
}

for (const placement of props) {
  if (!PROP_SIZES[placement.sprite]) problems.push(`unknown prop "${placement.sprite}"`);
}

if (problems.length > 0) {
  console.error('[build-hq-map] the map is not playable:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// --- emit --------------------------------------------------------------------

const tileLayer = (name, data, id, visible = true) => ({
  data,
  height: H,
  id,
  name,
  opacity: 1,
  type: 'tilelayer',
  visible,
  width: W,
  x: 0,
  y: 0,
});

const stringProperty = (name, value) => ({ name, type: 'string', value });

let nextObjectId = 1;

const map = {
  compressionlevel: -1,
  height: H,
  infinite: false,
  layers: [
    tileLayer('floor', floor, 1),
    tileLayer('walls', wallLayer, 2),
    tileLayer('collision', collisionLayer, 3, false),
    {
      draworder: 'topdown',
      id: 4,
      name: 'props',
      objects: props.map((placement) => ({
        height: 0,
        id: (nextObjectId += 1),
        name: placement.sprite,
        point: true,
        properties: [
          stringProperty('sprite', placement.sprite),
          ...(placement.z === undefined
            ? []
            : [{ name: 'z', type: 'int', value: placement.z }]),
        ],
        rotation: 0,
        type: 'prop',
        visible: true,
        width: 0,
        x: placement.x,
        y: placement.y,
      })),
      opacity: 1,
      type: 'objectgroup',
      visible: true,
      x: 0,
      y: 0,
    },
    {
      draworder: 'topdown',
      id: 5,
      name: 'spawns',
      objects: SPAWNS.map((spawn) => ({
        height: 0,
        id: (nextObjectId += 1),
        name: spawn.name,
        point: true,
        properties: [stringProperty('kind', spawn.kind)],
        rotation: 0,
        type: 'spawn',
        visible: true,
        width: 0,
        x: spawn.x * TILE + TILE / 2,
        y: spawn.y * TILE + TILE / 2,
      })),
      opacity: 1,
      type: 'objectgroup',
      visible: true,
      x: 0,
      y: 0,
    },
    {
      draworder: 'topdown',
      id: 6,
      name: 'zones',
      objects: ZONES.map((zone) => ({
        height: zone.bounds.height * TILE,
        id: (nextObjectId += 1),
        name: zone.label,
        properties: [
          stringProperty('kind', zone.kind),
          stringProperty('zoneId', zone.id),
          stringProperty('label', zone.label),
        ],
        rotation: 0,
        type: 'zone',
        visible: true,
        width: zone.bounds.width * TILE,
        x: zone.bounds.x * TILE,
        y: zone.bounds.y * TILE,
      })),
      opacity: 1,
      type: 'objectgroup',
      visible: true,
      x: 0,
      y: 0,
    },
  ],
  nextlayerid: 7,
  nextobjectid: nextObjectId + 1,
  orientation: 'orthogonal',
  properties: [stringProperty('name', 'Quintal HQ')],
  renderorder: 'right-down',
  tiledversion: '1.11.0',
  tileheight: TILE,
  tilesets: [
    {
      columns: 4,
      firstgid: SURFACE_FIRSTGID,
      image: '../../../apps/web/public/assets/world/terrain/surfaces.png',
      imageheight: 128,
      imagewidth: 128,
      margin: 0,
      name: 'surfaces',
      spacing: 0,
      tilecount: 16,
      tileheight: TILE,
      tilewidth: TILE,
    },
    {
      columns: 4,
      firstgid: WALL_FIRSTGID,
      image: '../../../apps/web/public/assets/world/walls/walls.png',
      imageheight: 128,
      imagewidth: 128,
      margin: 0,
      name: 'walls',
      spacing: 0,
      tilecount: 16,
      tileheight: TILE,
      tilewidth: TILE,
    },
  ],
  tilewidth: TILE,
  type: 'map',
  version: '1.10',
  width: W,
};

writeFileSync(OUT, `${JSON.stringify(map, null, 1)}\n`);

let walkableTiles = 0;
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (walkable(x, y)) walkableTiles += 1;
console.log(
  `[build-hq-map] ${W}x${H} tiles, ${props.length} props, ${ZONES.length} zones, ` +
    `${walkableTiles} walkable (${Math.round((walkableTiles / (W * H)) * 100)}%) -> packages/shared/maps/hq.json`,
);
