import { getDb, getOfficeSettings } from '@quintal/shared/db';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * What this office calls itself.
 *
 * Deliberately public and deliberately tiny. Somebody arriving at a URL has to
 * be able to recognise the place *before* they sign in — that is the whole
 * point of the name — so it cannot sit behind a session.
 *
 * Nothing else goes here. Instance settings include radii that describe how the
 * room behaves, and while none of that is secret, a public endpoint should
 * return the one field it exists to answer rather than everything the table
 * happens to hold.
 */
export async function GET(): Promise<NextResponse> {
  const settings = await getOfficeSettings(getDb());
  return NextResponse.json({ name: settings.name });
}
