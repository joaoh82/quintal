import { getDb, listInviteLinks } from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { currentOffice } from '@/lib/workspace';

import { GuestLinks } from './GuestLinks';
import { Visiting } from '../Visiting';

export const dynamic = 'force-dynamic';

export default async function GuestsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const here = await currentOffice(db, session);
  if (!here) redirect('/login');
  // A visitor does not get the host's invite links — who was let in, how many
  // times, until when — any more than they get to make one.
  if (here.role === 'guest') return <Visiting office={here.workspace.name} what="guest links" />;

  // Already newest-first — the ordering is the query's promise, not the page's.
  const links = await listInviteLinks(db, here.workspace.id);

  return <GuestLinks links={links} />;
}
