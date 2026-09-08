import { AGENT_KEY_PREFIX } from '@quintal/shared';
import { deploymentOrigin, findAgentByKey, getDb, verifyAgentChallenge } from '@quintal/shared/db';
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Which office an agent belongs to.
 *
 * Rooms are per-office, and a client has to name the room before the server
 * has authenticated anything — that is how the routing layer works. An agent
 * holding only its credential has no other way to learn which one to ask for,
 * so it asks here first: with a signed challenge (credentials v2), or with a
 * legacy `qa_` key in the `Authorization` header.
 *
 * This is not a permission. It hands back the office an agent is *already* in,
 * to a caller who has just proved they hold that agent's credential, and the
 * room proves the same fact again on join. Nothing is granted by knowing it.
 *
 * Unknown and revoked credentials get the same 401, so this cannot be used to
 * test whether one was once valid.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const header = request.headers.get('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const noStore = { headers: { 'cache-control': 'no-store' } };

  if (key.startsWith(AGENT_KEY_PREFIX)) {
    const agent = await findAgentByKey(getDb(), key);
    if (!agent) {
      return NextResponse.json({ error: 'unknown or revoked agent key' }, { status: 401 });
    }
    return NextResponse.json({ workspaceId: agent.workspaceId }, noStore);
  }

  const body: unknown = await request.json().catch(() => null);
  if (body && typeof body === 'object' && 'agentPubkey' in body) {
    const verdict = await verifyAgentChallenge(getDb(), body, { origin: deploymentOrigin() });
    if (!verdict.ok) return NextResponse.json({ error: verdict.message }, { status: 401 });
    return NextResponse.json({ workspaceId: verdict.credential.identity.workspaceId }, noStore);
  }

  return NextResponse.json(
    { error: 'expected a signed challenge { agentPubkey, sig, nonce, timestamp } or an agent key' },
    { status: 401 },
  );
}
