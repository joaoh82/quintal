import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from 'dotenv';

import { devWebPort } from '../constants.js';
import { WORKSPACE_ROOT } from './url.js';

let loaded = false;

/**
 * Quintal keeps a single `.env` at the repo root — one file for the web app,
 * the game server and the db scripts. Values already present in the real
 * environment always win (that is how deployments override things).
 *
 * `apps/web` loads it from `next.config.ts`, because Next only reads `.env`
 * files inside its own project directory.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  for (const file of ['.env.local', '.env']) {
    const path = resolve(WORKSPACE_ROOT, file);
    if (existsSync(path)) config({ path, quiet: true });
  }
}

/**
 * The origin every signature on this deployment is bound to.
 *
 * One rule, read by everything that issues or checks a challenge: the web app
 * (Better Auth's `baseURL`), the challenge endpoint an agent calls, and the
 * room server that verifies what the agent signed. Three readers of one
 * variable rather than three variables — a room that expected a different
 * origin from the one the web app issued would refuse every agent, and the
 * error would look like a bad key.
 */
export function deploymentOrigin(): string {
  const raw = process.env.BETTER_AUTH_URL ?? `http://localhost:${devWebPort()}`;
  // Read at boot by the room server's config, so a malformed value stops the
  // process here, naming the variable, instead of as a bare "Invalid URL" or a
  // sign-in page that refuses everybody.
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new Error(
      `BETTER_AUTH_URL must be the full address people open the office at, like https://office.example.com — not ${JSON.stringify(raw)}`,
    );
  }
  return url.origin;
}
