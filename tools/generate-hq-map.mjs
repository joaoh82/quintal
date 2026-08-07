#!/usr/bin/env node
/**
 * Generates `packages/shared/maps/hq.json` — Quintal's starter office.
 *
 * The output is a plain Tiled map: open it in https://www.mapeditor.org/ and
 * edit it by hand from here on. This script is how the map was bootstrapped,
 * not a build step — nothing runs it automatically, and once you've edited the
 * map in Tiled, re-running it will throw your edits away.
 *
 *   node tools/generate-hq-map.mjs
 *
 * Tileset: Kenney RPG Urban Pack, upscaled x2 to 32px tiles.
 * See apps/web/public/assets/CREDITS.md.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'packages/shared/maps/hq.json');

const WIDTH = 40;
const HEIGHT = 30;
const TILE = 32;

// --- tileset --------------------------------------------------------------
// Indices into the 27x18 Kenney sheet. Tiled GIDs are these + 1 (firstgid 1).
const SHEET_COLUMNS = 27;
const SHEET_TILES = 486;

/**
 * The sheet ships 3x3 room "9-slices": a solid floor tile with its eight
 * border tiles laid out around it. Given the centre, the ring is arithmetic.
 */
const nineSlice = (centre) => ({
  centre,
  tl: centre - SHEET_COLUMNS - 1,
  t: centre - SHEET_COLUMNS,
  tr: centre - SHEET_COLUMNS + 1,
  l: centre - 1,
  r: centre + 1,
  bl: centre + SHEET_COLUMNS - 1,
  b: centre + SHEET_COLUMNS,
  br: centre + SHEET_COLUMNS + 1,
});

/** Brown timber walls around a grey tile floor — the building shell. */
const OFFICE = nineSlice(117);
/** Blue-grey walls around a warm wood floor — the meeting rooms. */
const MEETING = nineSlice(109);
/** Flat teal, used as the Agent Bay carpet. */
const CARPET = 28;

const T = {
  deskFront: 273,
  deskChair: 275,
  cabinet: 300,
  bookcase: 303,
  couchL: 328,
  couchM: 329,
  couchR: 330,
  dock: 409,
  dockAlt: 411,
  whiteboardL: 386,
  whiteboardM: 387,
  whiteboardR: 388,
  plant: 259,
  planter: 286,
  pictureSmall: 362,
  pictureWide: 389,
  clock: 334,
};

// --- layers ---------------------------------------------------------------
const blank = () => new Array(WIDTH * HEIGHT).fill(0);
const layers = {
  floor: blank(),
  walls: blank(),
  furniture: blank(),
  decor: blank(),
};

const idx = (x, y) => y * WIDTH + x;
const put = (layer, x, y, tile) => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  layers[layer][idx(x, y)] = tile + 1; // -> GID
};
const fill = (layer, x0, y0, x1, y1, tile) => {
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) put(layer, x, y, tile);
};
const clear = (layer, x, y) => {
  layers[layer][idx(x, y)] = 0;
};

/** Draw a room: 9-slice walls on `walls`, solid floor underneath on `floor`. */
function room(x0, y0, x1, y1, slice) {
  fill('floor', x0, y0, x1, y1, slice.centre);
  for (let x = x0; x <= x1; x += 1) {
    put('walls', x, y0, slice.t);
    put('walls', x, y1, slice.b);
  }
  for (let y = y0; y <= y1; y += 1) {
    put('walls', x0, y, slice.l);
    put('walls', x1, y, slice.r);
  }
  put('walls', x0, y0, slice.tl);
  put('walls', x1, y0, slice.tr);
  put('walls', x0, y1, slice.bl);
  put('walls', x1, y1, slice.br);
}

/** Knock a walkable gap in a wall. */
const door = (x, y) => clear('walls', x, y);

// --- the office -----------------------------------------------------------

// Building shell: grey office floor wall-to-wall, timber walls around the edge.
room(0, 0, WIDTH - 1, HEIGHT - 1, OFFICE);

// Three meeting rooms along the north wall. Private zones; wood floors so they
// read as separate rooms at a glance.
const MEETING_ROOMS = [
  { x0: 2, y0: 2, x1: 12, y1: 8, doorX: 7, zoneId: 'focus', label: 'Focus Room' },
  { x0: 15, y0: 2, x1: 25, y1: 8, doorX: 20, zoneId: 'huddle', label: 'Huddle Room' },
  { x0: 28, y0: 2, x1: 38, y1: 8, doorX: 33, zoneId: 'deep-work', label: 'Deep Work' },
];

for (const mr of MEETING_ROOMS) {
  room(mr.x0, mr.y0, mr.x1, mr.y1, MEETING);
  door(mr.doorX, mr.y1);
  put('floor', mr.doorX, mr.y1, MEETING.centre);

  // Whiteboard on the north wall, and a table with chairs in the middle.
  const midX = Math.floor((mr.x0 + mr.x1) / 2);
  put('furniture', midX - 1, mr.y0 + 1, T.whiteboardL);
  put('furniture', midX, mr.y0 + 1, T.whiteboardM);
  put('furniture', midX + 1, mr.y0 + 1, T.whiteboardR);
  put('furniture', midX - 1, mr.y0 + 3, T.deskChair);
  put('furniture', midX, mr.y0 + 3, T.deskFront);
  put('furniture', midX + 1, mr.y0 + 3, T.deskChair);
  put('decor', mr.x0 + 1, mr.y0 + 1, T.pictureSmall);
  put('decor', mr.x1 - 1, mr.y0 + 1, T.clock);
}

// Open office: desk clusters either side of the central walkway.
for (const [cx, cy] of [
  [3, 11],
  [10, 11],
  [17, 11],
  [24, 11],
  [31, 11],
]) {
  put('furniture', cx, cy, T.deskFront);
  put('furniture', cx + 1, cy, T.deskFront);
  put('furniture', cx, cy + 2, T.deskChair);
  put('furniture', cx + 1, cy + 2, T.deskChair);
}

// Lounge in the north-east corner of the open office.
put('furniture', 35, 11, T.couchL);
put('furniture', 36, 11, T.couchM);
put('furniture', 37, 11, T.couchR);
put('decor', 35, 13, T.planter);

// Storage along the west wall.
put('furniture', 1, 14, T.bookcase);
put('furniture', 1, 15, T.cabinet);

// --- Agent Bay ------------------------------------------------------------
// The largest single feature in the building, directly south of where humans
// spawn: agents are the main cast, so their bay is the first thing you see.
const BAY = { x0: 6, y0: 17, x1: 33, y1: 27 };
fill('floor', BAY.x0, BAY.y0, BAY.x1, BAY.y1, CARPET);

// Two rows of agent workstations: a charging dock with a desk below it, with a
// wide central aisle so a crowded bay is still walkable.
const DOCK_COLUMNS = [8, 12, 16, 20, 24, 28, 32];
for (const [i, x] of DOCK_COLUMNS.entries()) {
  put('furniture', x, BAY.y0 + 1, i % 2 === 0 ? T.dock : T.dockAlt);
  put('furniture', x, BAY.y0 + 2, T.deskFront);
  put('furniture', x, BAY.y1 - 2, T.deskFront);
  put('furniture', x, BAY.y1 - 1, i % 2 === 0 ? T.dockAlt : T.dock);
}

for (const [x, y] of [
  [BAY.x0, BAY.y0],
  [BAY.x1, BAY.y0],
  [BAY.x0, BAY.y1],
  [BAY.x1, BAY.y1],
]) {
  put('decor', x, y, T.plant);
}

// Pictures hung on the meeting-room walls, facing the open office.
for (const x of [5, 20, 33]) put('decor', x, 9, T.pictureWide);

// Plants to break up the open floor.
for (const [x, y] of [
  [13, 10],
  [26, 10],
  [13, 15],
  [26, 15],
  [1, 1],
  [WIDTH - 2, HEIGHT - 2],
]) {
  put('decor', x, y, T.plant);
}

// --- object layers --------------------------------------------------------
const px = (tiles) => tiles * TILE;
/** Centre of a tile, for point objects. */
const centre = (tile) => tile * TILE + TILE / 2;

let nextObjectId = 1;
const objectId = () => nextObjectId++;

const property = (name, value) => ({ name, type: 'string', value });

const zoneObject = ({ x0, y0, x1, y1, kind, zoneId, label }) => ({
  height: px(y1 - y0 + 1),
  id: objectId(),
  name: label,
  properties: [property('kind', kind), property('zoneId', zoneId), property('label', label)],
  rotation: 0,
  type: 'zone',
  visible: true,
  width: px(x1 - x0 + 1),
  x: px(x0),
  y: px(y0),
});

const spawnObject = ({ name, x, y, kind }) => ({
  height: 0,
  id: objectId(),
  name,
  point: true,
  properties: [property('kind', kind)],
  rotation: 0,
  type: 'spawn',
  visible: true,
  width: 0,
  x: centre(x),
  y: centre(y),
});

const zones = [
  ...MEETING_ROOMS.map((mr) =>
    zoneObject({
      x0: mr.x0 + 1,
      y0: mr.y0 + 1,
      x1: mr.x1 - 1,
      y1: mr.y1 - 1,
      kind: 'private',
      zoneId: mr.zoneId,
      label: mr.label,
    }),
  ),
  zoneObject({
    x0: BAY.x0,
    y0: BAY.y0,
    x1: BAY.x1,
    y1: BAY.y1,
    kind: 'agent_area',
    zoneId: 'agent-bay',
    label: 'Agent Bay',
  }),
  zoneObject({
    x0: 16,
    y0: 14,
    x1: 24,
    y1: 16,
    kind: 'spawn',
    zoneId: 'lobby',
    label: 'Lobby',
  }),
];

const spawns = [
  spawnObject({ name: 'human-1', x: 20, y: 15, kind: 'human' }),
  spawnObject({ name: 'human-2', x: 19, y: 15, kind: 'human' }),
  ...DOCK_COLUMNS.map((x, i) =>
    spawnObject({ name: `agent-${i + 1}`, x, y: BAY.y0 + 3, kind: 'agent' }),
  ),
];

// --- assemble -------------------------------------------------------------
const tileLayer = (name, data, id) => ({
  data,
  height: HEIGHT,
  id,
  name,
  opacity: 1,
  type: 'tilelayer',
  visible: true,
  width: WIDTH,
  x: 0,
  y: 0,
});

const objectLayer = (name, objects, id) => ({
  draworder: 'index',
  id,
  name,
  objects,
  opacity: 1,
  type: 'objectgroup',
  visible: true,
  x: 0,
  y: 0,
});

const map = {
  compressionlevel: -1,
  height: HEIGHT,
  infinite: false,
  layers: [
    tileLayer('floor', layers.floor, 1),
    tileLayer('walls', layers.walls, 2),
    tileLayer('furniture', layers.furniture, 3),
    tileLayer('decor', layers.decor, 4),
    objectLayer('spawns', spawns, 5),
    objectLayer('zones', zones, 6),
  ],
  nextlayerid: 7,
  nextobjectid: nextObjectId,
  orientation: 'orthogonal',
  properties: [property('name', 'Quintal HQ')],
  renderorder: 'right-down',
  tiledversion: '1.11.0',
  tileheight: TILE,
  tilesets: [
    {
      columns: SHEET_COLUMNS,
      firstgid: 1,
      image: '../../../apps/web/public/assets/tilesets/kenney-rpg-urban-32.png',
      imageheight: 576,
      imagewidth: 864,
      margin: 0,
      name: 'kenney-rpg-urban-32',
      spacing: 0,
      tilecount: SHEET_TILES,
      tileheight: TILE,
      tilewidth: TILE,
    },
  ],
  tilewidth: TILE,
  type: 'map',
  version: '1.10',
  width: WIDTH,
};

writeFileSync(OUT, `${JSON.stringify(map, null, 1)}\n`);
console.log(`wrote ${OUT}`);
console.log(`  ${WIDTH}x${HEIGHT} tiles @ ${TILE}px, ${zones.length} zones, ${spawns.length} spawns`);
