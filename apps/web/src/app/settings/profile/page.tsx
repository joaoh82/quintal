import { npubEncode } from '@quintal/shared';
import { getDb, users } from '@quintal/shared/db';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { ProfileForm } from './ProfileForm';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  // Read the row rather than the session: the session's copy of the user is
  // cached in a cookie, so a name saved a moment ago would still look unsaved.
  const row = (
    await getDb()
      .select({ name: users.name, description: users.description, pubkey: users.pubkey })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];
  if (!row) redirect('/login');

  return (
    <ProfileForm
      name={row.name}
      description={row.description}
      npub={npubEncode(row.pubkey)}
      pubkey={row.pubkey}
      isGuest={session.session.isGuest}
    />
  );
}
