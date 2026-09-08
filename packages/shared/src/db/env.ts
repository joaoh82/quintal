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
  return new URL(process.env.BETTER_AUTH_URL ?? `http://localhost:${devWebPort()}`).origin;
}
