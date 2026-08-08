import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Long enough for a working session, short enough that a leaked one expires. */
const TOKEN_TTL = '2h';

/**
 * Mint a LiveKit token for the signed-in human.
 *
 * The URL is returned with the token rather than published as a
 * `NEXT_PUBLIC_` variable. Two reasons: it matches `/api/game/join`, which
 * already hands the browser its endpoint at request time, and a `NEXT_PUBLIC_`
 * value is baked in at build — which would mean one Docker image could only
 * ever talk to one LiveKit project, exactly the opposite of what step 0.9
 * wants.
 *
 * Voice is optional. With no LiveKit configured this answers 501 and the
 * office carries on without it; the UI says voice is unavailable rather than
 * retrying forever or failing in a way that looks broken.
 */
export async function POST(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;

  if (!url || !key || !secret) {
    return NextResponse.json(
      { error: 'voice is not configured on this instance' },
      { status: 501 },
    );
  }

  // One LiveKit room per map, named to match the Colyseus room — the same
  // people, the same place, one identity for both.
  const room = 'hq';

  const token = new AccessToken(key, secret, {
    // userId, not sessionId: the same human reconnecting is the same
    // participant, and the client matches remote tracks to avatars by this.
    identity: session.user.id,
    name: session.user.name,
    ttl: TOKEN_TTL,
  });

  token.addGrant({
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    // No data channel: chat already has a home in the Colyseus room, and two
    // transports for the same messages is two things to keep in agreement.
    canPublishData: false,
    // Audio only, forever. Quintal has no camera video by design; screen share
    // arrives in 0.7 and will widen this deliberately.
    canPublishSources: [TrackSource.MICROPHONE],
  });

  return NextResponse.json({ token: await token.toJwt(), url, room });
}
