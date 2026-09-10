import {
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listTeamsForWorkspace,
} from '@quintal/shared/db';
import { redirect } from 'next/navigation';

import { Teams } from './Teams';
import { Visiting } from '../Visiting';
import { requestSession, requestOffice } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Teams · Quintal' };

export default async function TeamsSettingsPage() {
  const session = await requestSession();
  if (!session) redirect('/login');

  const db = getDb();
  const here = await requestOffice();
  if (!here) redirect('/login');
  // A team is a word that wakes agents; a guest is passing through and has
  // no agents to put on one.
  if (here.role === 'guest') return <Visiting office={here.workspace.name} what="teams" />;
  const { workspace } = here;

  const [teams, agents, membership] = await Promise.all([
    listTeamsForWorkspace(db, workspace.id),
    listAgentsForWorkspace(db, workspace.id),
    findMembership(db, { userId: session.user.id, workspaceId: workspace.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground max-w-2xl text-sm">
        A team is a name for several agents at once. Say <span className="font-mono">@engineering</span>{' '}
        in a channel or across the office and every member is addressed, reads the same message
        and each other&rsquo;s replies, and they sort out among themselves who takes it. Members
        have to be in a channel to hear it there — Settings → Channels can add a whole team.
      </p>

      <Teams
        teams={teams}
        agents={agents
          .filter((agent) => agent.revokedAt === null)
          .map((agent) => ({ id: agent.id, name: agent.name, ownerName: agent.ownerName }))}
        currentUser={{
          userId: session.user.id,
          role: (membership?.role as 'owner' | 'admin' | 'member' | undefined) ?? null,
        }}
      />
    </div>
  );
}
