import { npubEncode } from '@quintal/shared';
import { getDb, users } from '@quintal/shared/db';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';


import { ThemeToggle } from '@/components/ThemeToggle';

import { OverlayKeyField } from './OverlayKeyField';
import { PushToTalkField } from './PushToTalkField';
import { ProfileForm } from './ProfileForm';
import { requestSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const session = await requestSession();
  if (!session) redirect('/login');

  // Read the row rather than the session: the session's copy of the user is
  // cached in a cookie, so a name saved a moment ago would still look unsaved.
  const row = (
    await getDb()
      .select({
        name: users.name,
        description: users.description,
        pubkey: users.pubkey,
        image: users.image,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  )[0];
  if (!row) redirect('/login');

  return (
    <div className="space-y-6">
      <ProfileForm
        name={row.name}
        description={row.description}
        npub={npubEncode(row.pubkey)}
        pubkey={row.pubkey}
        avatar={row.image ?? ''}
        isGuest={session.session.isGuest}
      />
      <OverlayKeyField />
      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Appearance</h2>
        <p className="text-muted-foreground text-xs">
          Light or dark for these pages, or whatever your computer is set to.
          Remembered in this browser. The office itself stays as it is.
        </p>
        <ThemeToggle />
      </section>

      <PushToTalkField />
    </div>
  );
}
