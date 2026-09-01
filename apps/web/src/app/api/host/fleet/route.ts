import { HOST_TOKEN_PREFIX } from '@quintal/shared';
import { fleetForHost, findHostByToken, getDb } from '@quintal/shared/db';
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * What a machine should be running.
 *
 * The direction matters: the host **pulls** this and decides what to spawn.
 * Nothing here is a command line — only a runtime id the host looks up in its
 * own catalogue — so even a compromised office cannot execute arbitrary things
 * on somebody's laptop. It also means a desktop app can serve the same shape
 * locally, with no network protocol to secure.
 *
 * Authenticated by host token in the `Authorization` header rather than a
 * cookie: this is called by a CLI, not a browser, and a bearer credential in a
 * header is the one thing every HTTP client agrees on.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token.startsWith(HOST_TOKEN_PREFIX)) {
    return NextResponse.json(
      { error: `expected a host token (${HOST_TOKEN_PREFIX}…) in the Authorization header` },
      { status: 401 },
    );
  }

  const host = await findHostByToken(getDb(), token);
  if (!host) {
    return NextResponse.json(
      { error: 'unknown or revoked host token' },
      { status: 401 },
    );
  }

  // The machine names itself: one token can be reused across machines, and the
  // fleet assigned to "laptop" should not boot on the build box.
  const label = (request.nextUrl.searchParams.get('host') ?? host.label).trim();

  return NextResponse.json({
    // The office this machine's agents belong to. Rooms are per-office, so a
    // harness that did not know this could only guess which one to join.
    host: { label, owner: host.ownerName, workspaceId: host.workspaceId },
    agents: await fleetForHost(getDb(), host, label),
  });
}
