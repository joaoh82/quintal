import {
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listHostTokens,
  listHostsForWorkspace,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { currentOffice } from '@/lib/workspace';

import { AgentsManager } from './AgentsManager';
import { Visiting } from '../Visiting';
import { Machines } from './Machines';
import { FleetControl } from './FleetControl';
import { RuntimePanels } from './RuntimePanels';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Agents · Quintal' };

export default async function AgentsSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const here = await currentOffice(db, session);
  if (!here) redirect('/login');
  if (here.role === 'guest') {
    return <Visiting office={here.workspace.name} what="agents and machines" />;
  }
  const { workspace } = here;

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

      <FleetControl />

      <RuntimePanels hosts={hosts} />

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
        hosts={hosts.map((host) => ({ label: host.label, runtimes: host.runtimes }))}
      />

      <p className="text-muted-foreground pt-2 text-xs">
        Building your own? The gateway protocol is public and documented in{' '}
        <code className="font-mono">docs/GATEWAY.md</code> — anything that speaks
        it is a valid agent.
      </p>
    </div>
  );
}
