import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from 'dotenv';

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
