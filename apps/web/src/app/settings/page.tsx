import { getDb, getOfficeSettings } from '@quintal/shared/db';

import { OfficeSettingsForm } from './OfficeSettingsForm';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Office settings · Quintal' };

export default async function OfficeSettingsPage() {
  const settings = await getOfficeSettings(getDb());
  return <OfficeSettingsForm settings={settings} />;
}
