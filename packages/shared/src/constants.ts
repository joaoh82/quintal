/** Size of one map tile, in pixels. World coordinates are in tiles, not pixels. */
export const TILE_SIZE = 32;

/** Colyseus room name for the one room type that exists today. */
export const ROOM_OFFICE = 'office';

/**
 * Path prefix the Colyseus endpoint is mounted under, in *both* modes:
 *
 * - dev: `next dev` on :3000 rewrites `/colyseus/*` to the game server on :2567
 *   (see `apps/web/next.config.ts`).
 * - prod: one Node process owns the port; `apps/server` strips the prefix before
 *   handing the request to Colyseus, and passes everything else to Next.
 *
 * So the client endpoint is `${origin}${COLYSEUS_PATH}` everywhere.
 */
export const COLYSEUS_PATH = '/colyseus';

/**
 * Health endpoint, owned by the game server in both modes — in dev `next dev`
 * proxies it to :2567, so `${origin}/health` answers the same way everywhere.
 * Reserved: no Next.js route may claim this path.
 */
export const HEALTH_PATH = '/health';

/** Port the game server listens on in dev (production uses PORT, default 3000). */
export const DEV_GAME_PORT = 2567;

/** Port `next dev` listens on. */
export const DEV_WEB_PORT = 3000;

/** Default port for the unified production process. */
export const DEFAULT_PORT = 3000;

/** How often (ms) the server broadcasts authoritative state. */
export const SIMULATION_TICK_MS = 50;

/** Radius, in tiles, within which players can hear each other (proximity audio, later). */
export const PROXIMITY_RADIUS_TILES = 5;

/** Build the Colyseus endpoint for a given page origin. */
export function colyseusEndpoint(origin: string): string {
  return `${origin.replace(/\/$/, '')}${COLYSEUS_PATH}`;
}
