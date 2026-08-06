import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Server, logger } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import {
  COLYSEUS_PATH,
  DEV_WEB_PORT,
  HEALTH_PATH,
  ROOM_OFFICE,
} from '@quintal/shared';
import {
  closeDb,
  loadRootEnv,
  resolveDatabaseUrl,
  runMigrations,
} from '@quintal/shared/db';

import { config } from './config.js';
import { handleHealth } from './http/health.js';
import { sendJson } from './http/json.js';
import { handleMatchmaking, isMatchmakingRequest } from './http/matchmaking.js';
import { createNextHandler, type NextRequestHandler } from './http/next-app.js';
import { OfficeRoom } from './rooms/OfficeRoom.js';

loadRootEnv();

// Self-hosters never run a migration command: bring the schema up to date first,
// before anything can touch the database.
logger.info(`[db] ${resolveDatabaseUrl().url}`);
await runMigrations();

const nextHandler: NextRequestHandler | undefined = config.isProduction
  ? await createNextHandler(config.webDir)
  : undefined;

/**
 * Everything under `/colyseus` belongs to the game server; the prefix is
 * stripped so Colyseus sees the paths it expects. Keeping the same prefix in
 * both modes means the client endpoint is `${origin}/colyseus` everywhere —
 * in dev it lands on `next dev`, which proxies it here (see next.config.ts).
 */
function stripColyseusPrefix(url: string | undefined): string | null {
  if (!url) return null;
  if (url === COLYSEUS_PATH) return '/';
  if (!url.startsWith(`${COLYSEUS_PATH}/`)) return null;
  return url.slice(COLYSEUS_PATH.length);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0] ?? '/';

  if (pathname === HEALTH_PATH) {
    handleHealth(res);
    return;
  }

  const colyseusPath = stripColyseusPrefix(pathname);
  if (colyseusPath !== null) {
    if (isMatchmakingRequest(colyseusPath)) {
      await handleMatchmaking(req, res, colyseusPath);
    } else {
      sendJson(res, 404, { code: 404, error: 'not found' });
    }
    return;
  }

  if (nextHandler) {
    await nextHandler(req, res);
    return;
  }

  // Dev mode: this process only owns the game server.
  sendJson(res, 404, {
    code: 404,
    error: 'game server only',
    hint: `The web app runs separately in development — try http://localhost:${DEV_WEB_PORT}`,
  });
}

const httpServer = createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    logger.error('[http] unhandled error', error);
    if (!res.headersSent) sendJson(res, 500, { code: 500, error: 'internal error' });
    else res.end();
  });
});

// Colyseus' ws server accepts every upgrade on this http server, so rewrite the
// URL before it gets there. `prependListener` keeps us ahead of ws regardless of
// registration order.
httpServer.prependListener('upgrade', (req: IncomingMessage) => {
  const stripped = stripColyseusPrefix(req.url?.split('?')[0]);
  if (stripped === null || !req.url) return;
  const queryIndex = req.url.indexOf('?');
  req.url = queryIndex === -1 ? stripped : stripped + req.url.slice(queryIndex);
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  greet: false,
  // We own the signal handlers below, so Colyseus shouldn't register its own.
  gracefullyShutdown: false,
});

gameServer.define(ROOM_OFFICE, OfficeRoom);

await gameServer.listen(config.port, config.host);

logger.info(
  config.isProduction
    ? `[quintal] web + game server on http://${config.host}:${config.port} (single process)`
    : `[quintal] game server on http://${config.host}:${config.port} — web app at http://localhost:${DEV_WEB_PORT}`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info(`[quintal] ${signal} received, shutting down`);
    gameServer
      .gracefullyShutdown(false)
      .catch((error: unknown) => logger.error('[quintal] shutdown failed', error))
      .finally(() => closeDb());
  });
}
