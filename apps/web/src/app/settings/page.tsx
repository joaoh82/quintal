import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getDb, getInstanceSettings, getOfficeSettings, isInstanceAdmin } from '@quintal/shared/db';

import { auth } from '@/lib/auth';
import { currentOffice } from '@/lib/workspace';

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
  // The office this session is in — for a guest, the one they are visiting,
  // whose radii are the ones in force around them.
  const here = await currentOffice(db, session);
  if (!here) redirect('/login');
  const { workspace } = here;

  // Two different things, from two different places: how *this office* works,
  // and what the *deployment* calls itself.
  const [settings, instance, canChangeInstance] = await Promise.all([
    getOfficeSettings(db, workspace.id),
    getInstanceSettings(db),
    // Naming the whole deployment belongs to whoever set it up, not to
    // everybody who signs in — see `isInstanceAdmin`.
    session.session.isGuest ? false : isInstanceAdmin(db, session.user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <OfficeSettingsForm
        settings={settings}
        instanceName={instance.name}
        workspaceName={workspace.name}
        canChangeInstance={canChangeInstance}
        canChangeOffice={!session.session.isGuest}
        host={host}
      />
      <Offices />
    </div>
  );
}
