import {
  ensurePersonalWorkspace,
  getDb,
  listInviteLinks,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { GuestLinks } from './GuestLinks';

export const dynamic = 'force-dynamic';

export default async function GuestsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  // Already newest-first — the ordering is the query's promise, not the page's.
  const links = await listInviteLinks(db, workspace.id);

  return <GuestLinks links={links} />;
}
