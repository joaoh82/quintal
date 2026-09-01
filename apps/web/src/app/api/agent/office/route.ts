import { AGENT_KEY_PREFIX } from '@quintal/shared';
import { findAgentByKey, getDb } from '@quintal/shared/db';
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Which office an agent key belongs to.
 *
 * Rooms are per-office, and a client has to name the room before the server
 * has authenticated anything — that is how the routing layer works. An agent
 * holding only its key has no other way to learn which one to ask for, so it
 * asks here first.
 *
 * This is not a permission. It hands back the office an agent is *already* in,
 * to a caller already holding that agent's key, and the room proves the same
 * fact again from the same key on join. Nothing is granted by knowing it.
 *
 * Unknown and revoked keys get the same 401, so this cannot be used to test
 * whether a key was once valid.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const header = request.headers.get('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!key.startsWith(AGENT_KEY_PREFIX)) {
    return NextResponse.json({ error: 'expected an agent key' }, { status: 401 });
  }

  const agent = await findAgentByKey(getDb(), key);
  if (!agent) {
    return NextResponse.json({ error: 'unknown or revoked agent key' }, { status: 401 });
  }

  return NextResponse.json(
    { workspaceId: agent.workspaceId },
    { headers: { 'cache-control': 'no-store' } },
  );
}
