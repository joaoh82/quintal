import type { IncomingMessage, ServerResponse } from 'node:http';

import { getBearerToken, matchMaker } from '@colyseus/core';

import { readJsonBody, sendJson } from './json.js';

/**
 * Colyseus ships HTTP matchmaking as framework-specific middleware (express,
 * uWebSockets, …). We serve it straight off the Node http server instead: it is
 * a handful of routes, it keeps express out of the dependency tree, and it lets
 * the same process hand every other request to Next.js.
 *
 * Routes (relative to COLYSEUS_PATH):
 *   POST /matchmake/:method/:roomName  -> seat reservation
 *   GET  /matchmake/:roomName          -> list available rooms
 *
 * No CORS headers: web and game are the same origin in production, and in dev
 * the browser only ever talks to `next dev`, which proxies to this server.
 */
const { allowedRoomNameChars, exposedMethods, matchmakeRoute } =
  matchMaker.controller;

export function isMatchmakingRequest(pathname: string): boolean {
  return pathname === `/${matchmakeRoute}` || pathname.startsWith(`/${matchmakeRoute}/`);
}

export async function handleMatchmaking(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const segments = pathname.split('/').filter(Boolean).slice(1); // drop "matchmake"

  try {
    if (req.method === 'GET') {
      const roomName = segments[0] ?? '';
      if (roomName !== '' && !allowedRoomNameChars.test(roomName)) {
        sendJson(res, 400, { code: 400, error: 'invalid room name' });
        return;
      }
      sendJson(res, 200, await matchMaker.query(roomName ? { name: roomName } : {}));
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { code: 405, error: 'method not allowed' });
      return;
    }

    const [method, roomName = ''] = segments;
    if (!method || !exposedMethods.includes(method)) {
      sendJson(res, 404, { code: 404, error: 'invalid matchmaking method' });
      return;
    }
    if (!allowedRoomNameChars.test(roomName)) {
      sendJson(res, 400, { code: 400, error: 'invalid room name' });
      return;
    }

    const clientOptions = await readJsonBody(req);
    const reservation: unknown = await matchMaker.controller.invokeMethod(
      method,
      roomName,
      clientOptions,
      {
        token: getBearerToken(req.headers.authorization ?? ''),
        headers: req.headers,
        ip: req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '',
        req,
      },
    );
    sendJson(res, 200, reservation);
  } catch (error) {
    // Colyseus error codes (e.g. 4212 MATCHMAKE_INVALID_CRITERIA) are not HTTP
    // statuses — the SDK reads them from the body, so keep the status sane.
    const code = (error as { code?: number }).code ?? 500;
    const message = (error as { message?: string }).message ?? 'internal error';
    const status =
      Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
    sendJson(res, status, { code, error: message });
  }
}
