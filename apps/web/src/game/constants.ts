/** Phaser asset keys. Strings in one place beats strings in six places. */
export const ASSETS = {
  tileset: 'kenney-rpg-urban-32',
  map: 'hq',
  emotes: 'kenney-emotes-32',
} as const;

export const PATHS = {
  tileset: '/assets/tilesets/kenney-rpg-urban-32.png',
  map: '/assets/maps/hq.json',
  emotes: '/assets/emotes/kenney-emotes-32.png',
} as const;

/** Emote sheet frames are this big; the frame index comes from `emoteFrames`. */
export const EMOTE_SIZE = 32;
/** How fast the thinking dots cycle. */
export const EMOTE_FRAME_MS = 350;

// Walking speed lives in `@quintal/shared` (movement.ts): the server simulates
// with it and the client predicts with it, so there must be exactly one copy.

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

/**
 * Reconciliation thresholds, in pixels.
 *
 * Client and server never agree exactly — they integrate the same movement at
 * different frame rates. Below the tolerance, ignore the difference. Above it,
 * ease across so the correction isn't visible as a shimmer. Past the snap
 * distance, prediction was wrong rather than merely stale: take the server's
 * answer immediately, because sliding a whole tile looks worse than a jump.
 */
export const RECONCILE_TOLERANCE_PX = 1.5;
export const RECONCILE_SNAP_PX = 48;
/** Share of the remaining error closed per patch. */
export const RECONCILE_LERP = 0.25;

/** Colours for the Z debug overlay. */
export const DEBUG_COLORS = {
  collision: 0xff3b6b,
  private: 0xff6b6b,
  spawn: 0xffd93d,
  agent_area: 0x4dd4ff,
  path: 0x8affc1,
} as const;
