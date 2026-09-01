import { COLYSEUS_PATH, displayName } from '@quintal/shared';
import { ensurePersonalWorkspace, getDb } from '@quintal/shared/db';
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

  // Which office this ticket is for, decided here rather than by the client.
  // A guest goes to the one their link admitted them to; everybody else to
  // their own. The room proves it again from the session either way — this is
  // convenience, not the gate.
  const workspaceId = session.session.isGuest
    ? session.session.guestWorkspaceId
    : (
        await ensurePersonalWorkspace(getDb(), {
          userId: session.user.id,
          name: session.user.name,
          pubkey: session.user.pubkey,
        })
      ).id;

  if (!workspaceId) {
    return NextResponse.json({ error: 'no office for this session' }, { status: 403 });
  }

  return NextResponse.json(
    {
      wsUrl: COLYSEUS_PATH,
      token: session.session.token,
      workspaceId,
      user: {
        id: session.user.id,
        // The effective name: this is handed to a client to draw. The room
        // derives its own copy the same way, so the nameplate and this agree.
        name: displayName(session.user),
      },
    },
    // The token is a live credential: never let a proxy or the browser keep it.
    { headers: { 'cache-control': 'no-store' } },
  );
}
