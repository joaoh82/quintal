import { personalMode } from '@quintal/shared';
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
 *
 * `personal` is the one other fact, and it is as public as the name: whether
 * this is somebody's private office — one owner, no guests — which the UI
 * uses to leave out the guest-link screens rather than show controls the
 * server will refuse. It says nothing about *whose*.
 */
export async function GET(): Promise<NextResponse> {
  const settings = await getInstanceSettings(getDb());
  return NextResponse.json({ name: settings.name, personal: personalMode() !== null });
}
