import {
  ensurePersonalWorkspace,
  findMembership,
  getDb,
  listAgentsForWorkspace,
  listChannels,
  listPeopleForWorkspace,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

import { Channels } from './Channels';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Channels · Quintal' };

export default async function ChannelsSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const [channels, people, agents, membership] = await Promise.all([
    listChannels(db, workspace.id),
    listPeopleForWorkspace(db, workspace.id),
    listAgentsForWorkspace(db, workspace.id),
    findMembership(db, session.user.id, workspace.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground max-w-2xl text-sm">
        A channel is a conversation you are in by membership rather than by
        standing somewhere. Nobody nearby hears it; every member reads it,
        wherever they are, and it is kept. Add an agent and it reads along — it
        answers when somebody says its name, and stays quiet otherwise.
      </p>

      <Channels
        channels={channels}
        people={people}
        agents={agents
          .filter((agent) => agent.revokedAt === null)
          .map((agent) => ({ id: agent.id, name: agent.name, ownerUserId: agent.ownerUserId }))}
        currentUser={{
          userId: session.user.id,
          role: (membership?.role as 'owner' | 'admin' | 'member' | undefined) ?? null,
        }}
      />
    </div>
  );
}
