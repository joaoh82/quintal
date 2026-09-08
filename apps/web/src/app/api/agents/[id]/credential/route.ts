import { deploymentOrigin, getDb } from '@quintal/shared/db';
import { NextResponse, type NextRequest } from 'next/server';

import { isHostTokenHeader, registerAgentCredential } from '@/lib/agent-credential';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST `{ agentPubkey, attestation }` — register an agent's keypair.
 *
 * With a host token in `Authorization`, the caller is a machine; otherwise it
 * is the signed-in person's browser, and the request has to come from this
 * site — a cookie-authenticated JSON POST is exactly what cross-site request
 * forgery is made of. The rules themselves are in `lib/agent-credential.ts`.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const db = getDb();

  const hostToken = isHostTokenHeader(request.headers.get('authorization'));
  if (hostToken) {
    const outcome = await registerAgentCredential(db, id, body, { via: 'host', token: hostToken });
    return NextResponse.json(outcome.body, { status: outcome.status });
  }

  const origin = request.headers.get('origin');
  if (origin && origin !== deploymentOrigin()) {
    return NextResponse.json({ error: 'Requests must come from this site.' }, { status: 403 });
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const outcome = await registerAgentCredential(db, id, body, {
    via: 'session',
    userId: session.user.id,
    isGuest: session.session.isGuest,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
