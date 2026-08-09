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

  const links = await listInviteLinks(db, workspace.id);
  links.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return <GuestLinks links={links} />;
}
