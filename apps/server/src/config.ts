import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT, devGamePort } from '@quintal/shared';

/** `apps/server` — same depth whether running from `src/` (tsx) or `dist/` (node). */
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(): string {
  try {
    const pkg = readFileSync(resolve(SERVER_ROOT, 'package.json'), 'utf8');
    return (JSON.parse(pkg) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  /**
   * Production is the unified mode: this process serves the Next.js app *and*
   * the Colyseus WebSocket server on one port. Development runs the game server
   * alone on :2567 while `next dev` owns :3000 and proxies `/colyseus` here.
   */
  isProduction,
  port: Number(process.env.PORT ?? (isProduction ? DEFAULT_PORT : devGamePort())),
  host: process.env.HOST ?? '0.0.0.0',
  /** Where the built Next.js app lives. */
  webDir: process.env.QUINTAL_WEB_DIR ?? resolve(SERVER_ROOT, '../web'),
  version: readVersion(),
} as const;
