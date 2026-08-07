import {
  ensurePersonalWorkspace,
  findMembership,
  getDb,
  listAgentsForWorkspace,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { AgentsManager } from './AgentsManager';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Agents · Quintal' };

export default async function AgentsSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
  });

  const [agents, membership] = await Promise.all([
    listAgentsForWorkspace(db, workspace.id),
    findMembership(db, workspace.id, session.user.id),
  ]);

  const canAdministerAll = membership?.role === 'owner' || membership?.role === 'admin';

  return (
    <main className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Agents</h1>
        <p className="text-muted-foreground text-xs">{workspace.name}</p>
        <Link href="/office" className="ml-auto text-xs underline underline-offset-2">
          Back to the office
        </Link>
      </header>

      <p className="text-muted-foreground max-w-2xl text-sm">
        Agents are workers in your office, not assistants behind a chat box. They
        get an avatar, they walk, and anyone standing nearby can see what they are
        doing. They are also permanently marked as non-human and permanently
        attributed to whoever made them — that is the deal that makes it safe to
        let them into the room.
      </p>

      <AgentsManager
        agents={agents}
        currentUserId={session.user.id}
        canAdministerAll={canAdministerAll}
      />

      <footer className="text-muted-foreground mt-auto pt-6 text-xs">
        Building your own? The gateway protocol is public and documented in{' '}
        <code className="font-mono">docs/GATEWAY.md</code> — anything that speaks
        it is a valid agent.
      </footer>
    </main>
  );
}
