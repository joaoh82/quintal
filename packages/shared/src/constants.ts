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

/**
 * The dev ports, which can move.
 *
 * Two instances on one machine is not an exotic case: it is how you check that
 * two offices are actually separate, and how anything about multiplayer gets
 * tested against more than one server. With the numbers baked in, the second
 * instance collides on both ports and the only workaround — pointing a second
 * office at `127.0.0.1` instead of `localhost` — is refused by the sign-in
 * origin check, correctly.
 *
 * Read through a function rather than exported as a constant so the value is
 * whatever the environment says *now*. These are called only from Node —
 * `next.config.ts` and the server — so no bundler has to inline them.
 */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  // A typo should not silently become port 0, which binds something arbitrary
  // and leaves you wondering why nothing is where you put it.
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be a port number, not ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function devWebPort(): number {
  return port('QUINTAL_WEB_PORT', DEV_WEB_PORT);
}

export function devGamePort(): number {
  return port('QUINTAL_GAME_PORT', DEV_GAME_PORT);
}

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
