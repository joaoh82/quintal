import { randomBytes } from 'node:crypto';

import {
  IMAGE_TYPES,
  OBJECT_MAX_BYTES,
  ObjectRejected,
  assertObjectAllowed,
  extensionFor,
  getStorage,
  sniffImageType,
} from '@quintal/shared/storage';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { objectUrl, uploadKeyFor } from '@/lib/objects';

export const dynamic = 'force-dynamic';

/**
 * Accept one image from somebody signed in.
 *
 * The body is the file; the type is read from its bytes and has to agree
 * with what the request claimed. Size and type limits are the shared ones,
 * enforced here before anything reaches a backend. Guests cannot upload:
 * a guest link is a URL that gets forwarded, and storage is the one thing a
 * visitor could cost the office.
 *
 * This is the general door. Avatars will have their own, which re-encodes
 * to a fixed size and replaces the previous one; it will call the same
 * store.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  if (session.session.isGuest) {
    return NextResponse.json({ error: 'guests cannot upload' }, { status: 403 });
  }

  const claimed = (request.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > OBJECT_MAX_BYTES) {
    return NextResponse.json({ error: `at most ${OBJECT_MAX_BYTES} bytes` }, { status: 413 });
  }

  const body = new Uint8Array(await request.arrayBuffer());
  const actual = sniffImageType(body);
  if (actual === null || actual !== claimed) {
    return NextResponse.json(
      { error: 'the bytes are not the image the request says they are' },
      { status: 415 },
    );
  }

  try {
    assertObjectAllowed(body, actual, { allowedTypes: IMAGE_TYPES });
  } catch (error: unknown) {
    if (error instanceof ObjectRejected) {
      return NextResponse.json(
        { error: error.message },
        { status: error.code === 'too_large' ? 413 : 415 },
      );
    }
    throw error;
  }

  const key = uploadKeyFor(session.user.id, randomBytes(12).toString('hex'), extensionFor(actual));
  await getStorage().put(key, body, { contentType: actual });

  return NextResponse.json(
    { key, url: objectUrl(key), contentType: actual, size: body.byteLength },
    { status: 201 },
  );
}
