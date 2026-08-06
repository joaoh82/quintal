import { ensurePersonalWorkspace, getDb } from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

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
    email: session.user.email,
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-8 px-6 py-16">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{workspace.name}</h1>
        <p className="text-muted-foreground text-sm">
          /{workspace.slug} · signed in as {session.user.email}
        </p>
      </header>

      <div className="border-border text-muted-foreground flex min-h-[24rem] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-10 text-center">
        <p className="text-foreground font-medium">The office goes here.</p>
        <p className="max-w-sm text-sm">
          The tile map, avatars and proximity voice land in later steps. For now
          this page exists to prove the protected route and your personal
          workspace.
        </p>
      </div>
    </main>
  );
}
