import { getStorage, isObjectKey } from '@quintal/shared/storage';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { mayReadObject } from '@/lib/objects';

export const dynamic = 'force-dynamic';

/**
 * Serve one object, to somebody allowed to see it.
 *
 * Bytes go through the app rather than straight from the bucket, for now:
 * it behaves identically on both backends and keeps authorisation in one
 * place. Presigned URLs can replace this behind the same interface when
 * proxying starts to hurt.
 *
 * A refusal is a 404 whichever reason applies — no such object, not a key,
 * not yours — so the route does not confirm what exists to somebody who may
 * not see it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const key = (await params).key.join('/');
  if (!isObjectKey(key) || !mayReadObject(session, key)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const object = await getStorage().get(key);
  if (!object) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // A copy into a plain ArrayBuffer: the fetch body type does not accept a
  // view over a shared or resizable buffer, which is what TypeScript sees.
  return new Response(new Uint8Array(object.body).buffer as ArrayBuffer, {
    status: 200,
    headers: {
      'content-type': object.contentType,
      'content-length': String(object.size),
      // Never let a browser guess at a type, and never let it render an
      // upload as a page. What was stored as an image is shown as one.
      'x-content-type-options': 'nosniff',
      'content-disposition': object.contentType.startsWith('image/') ? 'inline' : 'attachment',
      'cache-control': 'private, max-age=3600',
    },
  });
}
