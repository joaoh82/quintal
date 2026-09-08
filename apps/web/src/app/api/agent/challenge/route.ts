import { AUTH_NONCE_TTL_MS, isPubkeyHex } from '@quintal/shared';
import { deploymentOrigin, getDb, issueAgentChallenge } from '@quintal/shared/db';
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST `{ pubkey }` -> `{ nonce, origin, expiresInMs }` — the challenge an
 * agent signs to join (credentials v2).
 *
 * The same shape a human gets from `/api/auth/challenge`, filed under a
 * different identifier so the two can never consume each other's nonce. The
 * agent signs `quintal-auth:v1:<origin>:<nonce>:<timestamp>` with its own key
 * and presents the pieces at the room's door, where the nonce is consumed.
 *
 * Issued to anyone who asks: a nonce is worthless without the secret, and
 * refusing unknown keys would make this an oracle for which keys are
 * registered here.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body: unknown = await request.json().catch(() => null);
  const pubkey =
    body && typeof body === 'object' && 'pubkey' in body
      ? (body as { pubkey: unknown }).pubkey
      : undefined;

  if (!isPubkeyHex(pubkey)) {
    return NextResponse.json(
      { error: 'pubkey must be a 32-byte x-only public key in hex.' },
      { status: 400 },
    );
  }

  const nonce = await issueAgentChallenge(getDb(), pubkey as string);
  return NextResponse.json(
    { nonce, origin: deploymentOrigin(), expiresInMs: AUTH_NONCE_TTL_MS },
    { headers: { 'cache-control': 'no-store' } },
  );
}
