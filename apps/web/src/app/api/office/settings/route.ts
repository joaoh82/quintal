import { getDb, getOfficeSettings } from '@quintal/shared/db';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * The office's settings, for clients that need them at runtime.
 *
 * The room reads these straight from the database; the browser cannot, and
 * proximity audio needs the voice radius to know who it can hear. Signed-in
 * only — these are small numbers, but they describe somebody's office.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  return NextResponse.json(await getOfficeSettings(getDb()));
}
