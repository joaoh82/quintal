import {
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listOfficeCommandsForWorkspace,
  listTeamsForWorkspace,
} from '@quintal/shared/db';
import { redirect } from 'next/navigation';

import { Commands } from './Commands';
import { Visiting } from '../Visiting';
import { requestSession, requestOffice } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Commands · Quintal' };

export default async function CommandsSettingsPage() {
  const session = await requestSession();
  if (!session) redirect('/login');

  const db = getDb();
  const here = await requestOffice();
  if (!here) redirect('/login');
  // A command is a brief for the office's agents; a guest is passing through.
  if (here.role === 'guest') return <Visiting office={here.workspace.name} what="commands" />;
  const { workspace } = here;

  const [commands, agents, teams, membership] = await Promise.all([
    listOfficeCommandsForWorkspace(db, workspace.id),
    listAgentsForWorkspace(db, workspace.id),
    listTeamsForWorkspace(db, workspace.id),
    findMembership(db, { userId: session.user.id, workspaceId: workspace.id }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground max-w-2xl text-sm">
        A command is a request you make often, kept with how you want it done. Type{' '}
        <span className="font-mono">!review @engineering https://github.com/…/pull/155</span> and
        every agent it reaches gets the review instructions along with the link — the same as asking
        in words, without writing the brief again. Anyone here may use a command; any member may
        make one. Name an agent or a team after it, or give it a default so the name can be left
        out.
      </p>

      <Commands
        commands={commands}
        targets={[
          ...teams.map((team) => ({ value: `team:${team.id}`, label: `@${team.name} (team)` })),
          ...agents
            .filter((agent) => agent.revokedAt === null)
            .map((agent) => ({ value: `agent:${agent.id}`, label: `◆ ${agent.name} (${agent.ownerName}’s)` })),
        ]}
        currentUser={{
          userId: session.user.id,
          role: (membership?.role as 'owner' | 'admin' | 'member' | undefined) ?? null,
        }}
      />
    </div>
  );
}
