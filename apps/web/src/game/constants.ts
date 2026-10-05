import { BODIES } from '@quintal/shared';

/** Phaser asset keys. Strings in one place beats strings in six places. */
export const ASSETS = {
  surfaces: 'world-surfaces',
  walls: 'world-walls',
  map: 'hq',
  emotes: 'kenney-emotes-32',
} as const;

export const PATHS = {
  surfaces: '/assets/world/terrain/surfaces.png',
  walls: '/assets/world/walls/walls.png',
  map: '/assets/maps/hq.json',
  emotes: '/assets/emotes/kenney-emotes-32.png',
} as const;

/**
 * Prop atlases, by the prefix a map object names them with: `office/desk-north`
 * loads from `props/office.png`. Frame names repeat across environments — three
 * of them have a `chair-north` — so the prefix is what keeps them apart.
 *
 * The anchor is the prop's ground point in its cell, as a fraction, and is what
 * a sprite's origin is set to: place a prop at the pixel it stands on and it
 * both lands and sorts correctly. The retained 64x64 office props anchor
 * differently from the 128x96 ones, which is the only reason this is a table
 * rather than a constant.
 */
export const PROP_ATLASES = {
  'office-base': { origin: 62 / 64 },
  office: { origin: 94 / 96 },
  meeting: { origin: 94 / 96 },
  cafeteria: { origin: 94 / 96 },
  hallway: { origin: 94 / 96 },
  garden: { origin: 94 / 96 },
} as const;

export type PropAtlasKey = keyof typeof PROP_ATLASES;

export function isPropAtlasKey(value: string): value is PropAtlasKey {
  return Object.hasOwn(PROP_ATLASES, value);
}

export const propAtlasPath = (key: PropAtlasKey) => ({
  texture: `/assets/world/props/${key}.png`,
  atlas: `/assets/world/props/${key}.json`,
});

export const bodyPath = (body: string) => `/assets/world/avatars/${body}.png`;
export const bodyTexture = (body: string) => `body-${body}`;

/** Emote sheet frames are this big; the frame index comes from `emoteFrames`. */
export const EMOTE_SIZE = 32;
/** How fast the thinking dots cycle. */
export const EMOTE_FRAME_MS = 350;

// Walking speed lives in `@quintal/shared` (movement.ts): the server simulates
// with it and the client predicts with it, so there must be exactly one copy.

/**
 * A body sheet: eight columns by four rows of 32x48 frames.
 *
 * Rows are south, west, east and north — the pack's names for the four
 * directions the office calls down, left, right and up. Columns pair up into
 * four states, of which the office drives two; `sit` and `work` are loaded and
 * indexed here because the frames exist and naming them costs nothing, but
 * nothing plays them until the map has seats in it.
 */
export const BODY_FRAME = { width: 32, height: 48 } as const;
/** Feet, as a fraction of the frame: where the sprite meets the floor. */
export const BODY_ORIGIN = { x: 16 / 32, y: 42 / 48 } as const;

const BODY_COLUMNS = 8;

export const BODY_ROW: Record<'down' | 'left' | 'right' | 'up', number> = {
  down: 0,
  left: 1,
  right: 2,
  up: 3,
};

export const BODY_STATE_COLUMN = { idle: 0, walk: 2, sit: 4, work: 6 } as const;
export type BodyState = keyof typeof BODY_STATE_COLUMN;

/**
 * Per-frame timing from the pack, in milliseconds.
 *
 * Idle is deliberately lopsided: a long hold and a two-frame blink. Phaser
 * spreads an animation's `duration` evenly and then adds each frame's own
 * `duration` on top, so the pair below is expressed as "the short frame, plus
 * the extra the long one holds for".
 */
export const BODY_TIMING: Record<BodyState, readonly [number, number]> = {
  idle: [1400, 120],
  walk: [180, 180],
  sit: [800, 800],
  work: [250, 250],
};

export const bodyFrames = (state: BodyState, direction: keyof typeof BODY_ROW): [number, number] => {
  const base = BODY_ROW[direction] * BODY_COLUMNS + BODY_STATE_COLUMN[state];
  return [base, base + 1];
};

export const bodyAnimation = (body: string, state: BodyState, direction: string) =>
  `${body}-${state}-${direction}`;

/** Every body is loaded up front: 12 sheets is 450KB, and a late one pops in. */
export const BODY_IDS = BODIES;

/** Camera zoom. Integer, so pixel art stays on whole pixels. */
export const CAMERA_ZOOM = 2;
/** 0 = camera never catches up, 1 = rigid. */
export const CAMERA_LERP = 0.12;

/**
 * Draw order.
 *
 * Props and people share one scale: a freestanding object's depth is the y of
 * the ground it stands on, and a person's is the y of their feet, so walking
 * south past a bookcase puts you in front of it and walking north puts you
 * behind. That only works if everything in the world sorts on the same number,
 * which is why the fixed layers sit below zero and the overlays sit above any y
 * the map can produce.
 */
export const DEPTH = {
  floor: -20,
  walls: -10,
  /** Zone names, painted on the floor: above the walls, under the furniture. */
  zoneLabel: -5,
  /** The ring under an avatar's feet, just below the avatar itself. */
  ringOffset: -1,
  /** Higher than any world y, so nameplates are never behind a plant. */
  label: 100_000,
  status: 100_001,
  bubble: 100_010,
  emote: 100_020,
  debug: 200_000,
} as const;

/**
 * Reconciliation, in pixels and seconds. See `reconcile.ts` for when it runs —
 * only at rest, never against a position the server reported mid-walk.
 *
 * At rest both sides should agree exactly, so a gap is eased away and then
 * closed outright once it is too small to see. Past the snap distance,
 * prediction was wrong rather than merely late: take the server's answer
 * immediately, because sliding a whole tile looks worse than a jump.
 */
export const RECONCILE_EXACT_PX = 0.5;
export const RECONCILE_SNAP_PX = 48;
/** Time constant of the ease: about two thirds of the gap closes in this long. */
export const RECONCILE_EASE_SECONDS = 0.06;

/** Colours for the Z debug overlay. */
export const DEBUG_COLORS = {
  collision: 0xff3b6b,
  private: 0xff6b6b,
  common: 0x9aa7bd,
  spawn: 0xffd93d,
  agent_area: 0x4dd4ff,
  path: 0x8affc1,
} as const;
