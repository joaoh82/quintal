import { getDb, getInstanceSettings } from '@quintal/shared/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * What this office calls itself.
 *
 * Deliberately public and deliberately tiny. Somebody arriving at a URL has to
 * be able to recognise the place *before* they sign in — that is the whole
 * point of the name — so it cannot sit behind a session.
 *
 * Nothing else goes here, and now there is nothing else to leak: the radii that
 * describe how a room behaves moved to the office they belong to, and this
 * table holds only the deployment's name.
 */
export async function GET(): Promise<NextResponse> {
  const settings = await getInstanceSettings(getDb());
  return NextResponse.json({ name: settings.name });
}
