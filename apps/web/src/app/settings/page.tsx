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
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect('/login');

  // From the request, not from `window`: this is handed to a client component
  // that is still server-rendered, and reading it there would render one thing
  // on the server and another on the client.
  const host = requestHeaders.get('host') ?? '';

  const db = getDb();
  const [settings, workspace, canChangeInstance] = await Promise.all([
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
        canChangeInstance={canChangeInstance}
        host={host}
      />
      <Offices />
    </div>
  );
}
