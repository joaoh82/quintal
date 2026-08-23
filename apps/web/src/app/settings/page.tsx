import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  ensurePersonalWorkspace,
  getDb,
  getOfficeSettings,
} from '@quintal/shared/db';

import { auth } from '@/lib/auth';

import { OfficeSettingsForm } from './OfficeSettingsForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Office settings · Quintal' };

export default async function OfficeSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const [settings, workspace] = await Promise.all([
    getOfficeSettings(db),
    ensurePersonalWorkspace(db, {
      userId: session.user.id,
      name: session.user.name,
      pubkey: session.user.pubkey,
    }),
  ]);

  return <OfficeSettingsForm settings={settings} workspaceName={workspace.name} />;
}
