import { TILE_SIZE } from '@quintal/shared';

/** Phaser asset keys. Strings in one place beats strings in six places. */
export const ASSETS = {
  tileset: 'kenney-rpg-urban-32',
  map: 'hq',
} as const;

export const PATHS = {
  tileset: '/assets/tilesets/kenney-rpg-urban-32.png',
  map: '/assets/maps/hq.json',
} as const;

/** Walking speed. Four tiles a second reads as brisk but not twitchy. */
export const TILES_PER_SECOND = 4;
export const WALK_SPEED = TILES_PER_SECOND * TILE_SIZE;

/**
 * Character frames on the Kenney sheet: four columns (facing) x three rows
 * (walk cycle), starting at column 23 of a 27-wide sheet.
 * See apps/web/public/assets/CREDITS.md.
 */
const SHEET_COLUMNS = 27;
const CHARACTER_COLUMN = 23;
const CHARACTER_ROW = 0;

const frame = (facingOffset: number, step: number) =>
  (CHARACTER_ROW + step) * SHEET_COLUMNS + CHARACTER_COLUMN + facingOffset;

/** Column order on the sheet is left, down, up, right. */
export const CHARACTER_FRAMES = {
  left: [frame(0, 0), frame(0, 1), frame(0, 2)],
  down: [frame(1, 0), frame(1, 1), frame(1, 2)],
  up: [frame(2, 0), frame(2, 1), frame(2, 2)],
  right: [frame(3, 0), frame(3, 1), frame(3, 2)],
} as const;

/** Camera zoom. Integer, so pixel art stays on whole pixels. */
export const CAMERA_ZOOM = 2;
/** 0 = camera never catches up, 1 = rigid. */
export const CAMERA_LERP = 0.12;

/** Avatar hitbox, in pixels — narrower than the sprite so doorways feel fair. */
export const BODY = { width: 18, height: 14, offsetX: 7, offsetY: 17 } as const;

/** Colours for the Z debug overlay. */
export const DEBUG_COLORS = {
  collision: 0xff3b6b,
  private: 0xff6b6b,
  spawn: 0xffd93d,
  agent_area: 0x4dd4ff,
  path: 0x8affc1,
} as const;
