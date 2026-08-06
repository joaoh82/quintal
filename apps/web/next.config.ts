import { COLYSEUS_PATH, DEV_GAME_PORT, HEALTH_PATH } from '@quintal/shared';
import { loadRootEnv } from '@quintal/shared/db';
import type { NextConfig } from 'next';

// Quintal keeps one `.env` at the repo root; Next only reads env files inside
// its own project directory, so load it here.
loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // libSQL loads native bindings through a dynamic require, which webpack
  // can't follow. These are also declared as direct dependencies of this app so
  // Next can resolve them here and leave them to Node at runtime.
  serverExternalPackages: ['@libsql/client', 'libsql', '@libsql/hrana-client'],

  typescript: {
    ignoreBuildErrors: false,
  },

  async rewrites() {
    // Production is a single process — `apps/server` serves this app and
    // Colyseus off the same port, so nothing to proxy.
    if (process.env.NODE_ENV === 'production') return [];

    // Development: `next dev` owns :3000, the game server runs on :2567.
    // Proxying (HTTP matchmaking + the WebSocket upgrade) keeps the browser on
    // one origin, so client code never needs a separate endpoint per mode.
    const gameServer = `http://127.0.0.1:${DEV_GAME_PORT}`;
    return [
      {
        source: `${COLYSEUS_PATH}/:path*`,
        destination: `${gameServer}${COLYSEUS_PATH}/:path*`,
      },
      // The game server owns /health in production too; proxying it here means
      // the URL is the same in both modes.
      { source: HEALTH_PATH, destination: `${gameServer}${HEALTH_PATH}` },
    ];
  },
};

export default nextConfig;
