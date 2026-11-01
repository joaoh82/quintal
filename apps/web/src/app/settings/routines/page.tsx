import {
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listOfficeCommandsForWorkspace,
  listRoutinesForWorkspace,
} from '@quintal/shared/db';
import { redirect } from 'next/navigation';

import { Routines } from './Routines';
import { Visiting } from '../Visiting';
import { requestSession, requestOffice } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Routines · Quintal' };

export default async function RoutinesSettingsPage() {
  const session = await requestSession();
  if (!session) redirect('/login');

  const db = getDb();
  const here = await requestOffice();
  if (!here) redirect('/login');
  // A routine is a standing request to one of your agents; a guest has none.
  if (here.role === 'guest') return <Visiting office={here.workspace.name} what="routines" />;
  const { workspace } = here;

  const [routines, agents, commands, membership] = await Promise.all([
    listRoutinesForWorkspace(db, workspace.id),
    listAgentsForWorkspace(db, workspace.id),
    listOfficeCommandsForWorkspace(db, workspace.id),
    findMembership(db, { userId: session.user.id, workspaceId: workspace.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground max-w-2xl text-sm">
        A routine is a standing request to one of your agents, on a schedule: every hour, review
        the open pull requests; weekdays at nine, see what is on the board; in an hour, check the
        deploy. It fires as a line from you in your DM with the agent, with the brief attached, and
        the agent reports there. Only an agent’s owner puts a routine on it. A routine fires while
        the agent is in the office; one it was away for is made up when it comes back, unless the
        next is already due.
      </p>

      <Routines
        routines={routines}
        agents={agents
          .filter((agent) => agent.revokedAt === null && agent.ownerUserId === session.user.id)
          .map((agent) => ({ id: agent.id, name: agent.name }))}
        commands={commands.map((command) => ({ id: command.id, name: command.name, summary: command.summary }))}
        currentUser={{
          userId: session.user.id,
          role: (membership?.role as 'owner' | 'admin' | 'member' | undefined) ?? null,
        }}
      />
    </div>
  );
}
