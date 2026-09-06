import { AvatarRejected, clearAvatar, getDb, setAvatar } from '@quintal/shared/db';
import { AVATAR_MAX_BYTES, getStorage } from '@quintal/shared/storage';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { objectUrl, readBounded } from '@/lib/objects';

export const dynamic = 'force-dynamic';

/**
 * Your own face.
 *
 * The browser re-encodes whatever was picked to a 128px PNG with a canvas
 * before sending it here — which is what strips the metadata a camera
 * leaves in a photograph — and this checks, from the bytes, that it got
 * exactly that. Replacing removes the previous one. Guests keep the face
 * they arrived with, for the same reason they keep their name.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  if (session.session.isGuest) {
    return NextResponse.json({ error: 'guests keep the face they arrived with' }, { status: 403 });
  }

  const body = await readBounded(request, AVATAR_MAX_BYTES);
  if (body === null) {
    return NextResponse.json({ error: `at most ${AVATAR_MAX_BYTES} bytes` }, { status: 413 });
  }

  try {
    const key = await setAvatar(getDb(), getStorage(), session.user.id, body);
    return NextResponse.json({ key, url: objectUrl(key) }, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof AvatarRejected) {
      return NextResponse.json({ error: error.message }, { status: 415 });
    }
    throw error;
  }
}

/** Back to the face derived from your key. */
export async function DELETE(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  if (session.session.isGuest) {
    return NextResponse.json({ error: 'guests keep the face they arrived with' }, { status: 403 });
  }

  const removed = await clearAvatar(getDb(), getStorage(), session.user.id);
  return NextResponse.json({ removed });
}
