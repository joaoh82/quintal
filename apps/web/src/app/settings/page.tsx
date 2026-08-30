import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  ensurePersonalWorkspace,
  getDb,
  getOfficeSettings,
  isInstanceOwner,
} from '@quintal/shared/db';

import { auth } from '@/lib/auth';

import { Offices } from './Offices';
import { OfficeSettingsForm } from './OfficeSettingsForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Office settings · Quintal' };

export default async function OfficeSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const [settings, workspace, canNameServer] = await Promise.all([
    getOfficeSettings(db),
    ensurePersonalWorkspace(db, {
      userId: session.user.id,
      name: session.user.name,
      pubkey: session.user.pubkey,
    }),
    // Naming the whole deployment belongs to whoever set it up, not to
    // everybody who signs in — see `isInstanceOwner`.
    session.session.isGuest ? false : isInstanceOwner(db, session.user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <OfficeSettingsForm
        settings={settings}
        workspaceName={workspace.name}
        canNameServer={canNameServer}
      />
      <Offices />
    </div>
  );
}
