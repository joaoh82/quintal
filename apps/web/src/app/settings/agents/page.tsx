import {
  ensurePersonalWorkspace,
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listHostTokens,
  listHostsForWorkspace,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { AgentsManager } from './AgentsManager';
import { Machines } from './Machines';
import { RuntimeList } from './RuntimeList';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Agents · Quintal' };

export default async function AgentsSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const [agents, membership, hosts, machines] = await Promise.all([
    listAgentsForWorkspace(db, workspace.id),
    findMembership(db, workspace.id, session.user.id),
    listHostsForWorkspace(db, workspace.id),
    listHostTokens(db, workspace.id),
  ]);

  const canAdministerAll = membership?.role === 'owner' || membership?.role === 'admin';

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground max-w-2xl text-sm">
        Agents are workers in your office, not assistants behind a chat box. They
        get an avatar, they walk, and anyone standing nearby can see what they are
        doing. They are also permanently marked as non-human and permanently
        attributed to whoever made them — that is the deal that makes it safe to
        let them into the room.
      </p>

      <RuntimeList hosts={hosts} />

      <Machines
        machines={machines.map((row) => ({
          ...row,
          createdAt: row.createdAt.getTime(),
          lastSeenAt: row.lastSeenAt?.getTime() ?? null,
          revokedAt: row.revokedAt?.getTime() ?? null,
        }))}
        currentUserId={session.user.id}
      />

      <AgentsManager
        agents={agents}
        currentUserId={session.user.id}
        canAdministerAll={canAdministerAll}
        machines={machines.filter((row) => row.revokedAt === null).map((row) => row.label)}
      />

      <p className="text-muted-foreground pt-2 text-xs">
        Building your own? The gateway protocol is public and documented in{' '}
        <code className="font-mono">docs/GATEWAY.md</code> — anything that speaks
        it is a valid agent.
      </p>
    </div>
  );
}
