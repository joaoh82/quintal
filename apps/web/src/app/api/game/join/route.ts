import { COLYSEUS_PATH } from '@quintal/shared';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Hands the browser what it needs to open a game connection: where the room
 * server is, and proof of who it is.
 *
 * A WebSocket upgrade isn't an HTTP request the room can read cookies from, so
 * the token has to travel in the join options. The room verifies it against the
 * sessions table — the same row Better Auth wrote — so signing out drops the
 * ability to reconnect too.
 *
 * The endpoint is derived from this request rather than an env var: in
 * production one process serves both the app and the room server, and in
 * development `next dev` proxies `/colyseus` to :2567. Same origin either way,
 * so there is nothing to configure and nothing to get wrong.
 */
export async function POST(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  return NextResponse.json(
    {
      wsUrl: COLYSEUS_PATH,
      token: session.session.token,
      user: {
        id: session.user.id,
        name: session.user.name,
      },
    },
    // The token is a live credential: never let a proxy or the browser keep it.
    { headers: { 'cache-control': 'no-store' } },
  );
}
