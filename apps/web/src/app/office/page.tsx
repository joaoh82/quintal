import { displayName } from '@quintal/shared';
import { ensurePersonalWorkspace, getDb } from '@quintal/shared/db';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SignOutButton } from '@/components/SignOutButton';
import { AutoStartFleet } from '@/components/AutoStartFleet';
import { MachineRegistration } from '@/components/MachineRegistration';
import { OfficeCanvas } from '@/game/OfficeCanvas';
import { auth } from '@/lib/auth';

// Session-dependent: never prerender.
export const dynamic = 'force-dynamic';

export default async function OfficePage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  // Idempotent safety net for accounts created before this hook existed, and
  // for anyone whose signup was interrupted halfway.
  const workspace = await ensurePersonalWorkspace(getDb(), {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  return (
    <main className="flex h-dvh flex-col gap-3 p-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <h1 className="text-lg font-semibold tracking-tight">{workspace.name}</h1>
        <p className="text-muted-foreground text-xs">
          /{workspace.slug} · {displayName(session.user)}
        </p>
        <p className="text-muted-foreground ml-auto text-xs">
          Enter to chat · @name to address someone
        </p>
        <Link
          href="/settings"
          className="hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
        >
          Settings
        </Link>
        <SignOutButton />
      </header>

      <div className="min-h-0 flex-1">
        <OfficeCanvas />
      </div>

      <MachineRegistration />
      <AutoStartFleet />
    </main>
  );
}
