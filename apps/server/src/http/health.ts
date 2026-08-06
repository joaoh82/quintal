import type { ServerResponse } from 'node:http';

import { matchMaker } from '@colyseus/core';

import { config } from '../config.js';

export interface HealthPayload {
  /** Rooms hosted by this process. */
  rooms: number;
  /** Currently connected clients (humans + agents). */
  clients: number;
  version: string;
}

export function healthPayload(): HealthPayload {
  const { roomCount, ccu } = matchMaker.stats.local;
  return { rooms: roomCount, clients: ccu, version: config.version };
}

export function handleHealth(res: ServerResponse): void {
  const body = JSON.stringify(healthPayload());
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
