'use client';

import { mayAddToChannel, mayRemoveFromChannel, type MembershipRole } from '@quintal/shared';
import type { ChannelSummary } from '@quintal/shared/db';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  addChannelMemberAction,
  addTeamToChannelAction,
  createChannelAction,
  joinChannelAction,
  removeChannelMemberAction,
  type ChannelActionState,
} from './actions';

interface ChannelsProps {
  channels: ChannelSummary[];
  /** The office's teams, so a whole one can be put in a channel at once. */
  teams: Array<{ id: string; name: string; members: Array<{ id: string; name: string }> }>;
  people: Array<{ id: string; name: string; role: string }>;
  agents: Array<{ id: string; name: string; ownerUserId: string }>;
  currentUser: { userId: string; role: MembershipRole | null };
}

const IDLE: ChannelActionState = { ok: true };

/**
 * Channels and who is in them.
 *
 * The picker for adding somebody offers people and agents in one list, but
 * only the agents *you* own: the rule that nobody else may add your agent is
 * enforced in the action, and a list that offers what the action will refuse
 * is a list that lies.
 */
export function Channels({ channels, teams, people, agents, currentUser }: ChannelsProps) {
  const [created, create, creating] = useActionState(createChannelAction, IDLE);

  return (
    <div className="space-y-6">
      <form action={create} className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">New channel</span>
            <Input name="name" placeholder="engineering" maxLength={40} className="w-56" required />
          </label>
          <Button type="submit" disabled={creating}>
            {creating ? 'Making…' : 'Make channel'}
          </Button>
        </div>
        {!created.ok && created.error ? (
          <p className="text-destructive text-sm" role="alert">
            {created.error}
          </p>
        ) : null}
      </form>

      {channels.length === 0 ? (
        <p className="text-muted-foreground text-sm">No channels yet.</p>
      ) : (
        <ul className="space-y-4">
          {channels.map((channel) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              teams={teams}
              people={people}
              agents={agents}
              currentUser={currentUser}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChannelCard({
  channel,
  teams,
  people,
  agents,
  currentUser,
}: { channel: ChannelSummary } & Omit<ChannelsProps, 'channels'>) {
  const [added, add, adding] = useActionState(addChannelMemberAction, IDLE);
  const [teamAdded, addTeam, addingTeam] = useActionState(addTeamToChannelAction, IDLE);
  const present = new Set(channel.members.map((member) => member.id));
  const isMember = present.has(currentUser.userId);
  // A team worth offering has somebody on it who is not here yet.
  const addableTeams = teams.filter((team) =>
    team.members.some((member) => !present.has(member.id)),
  );

  const addable = [
    ...people
      .filter((person) => !present.has(person.id))
      .filter((person) =>
        mayAddToChannel(currentUser, { id: person.id, kind: 'human' }),
      )
      .map((person) => ({ key: `human:${person.id}`, label: person.name })),
    ...agents
      .filter((agent) => !present.has(agent.id))
      .filter((agent) =>
        mayAddToChannel(currentUser, {
          id: agent.id,
          kind: 'agent',
          ownerUserId: agent.ownerUserId,
        }),
      )
      .map((agent) => ({ key: `agent:${agent.id}`, label: `◆ ${agent.name}` })),
  ];

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-sm font-medium">#{channel.slug}</h2>
        {channel.name !== channel.slug ? (
          <span className="text-muted-foreground text-xs">{channel.name}</span>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {channel.members.length} {channel.members.length === 1 ? 'member' : 'members'}
        </span>
        {!isMember && currentUser.role !== null ? (
          <form action={joinChannelAction} className="ml-auto">
            <input type="hidden" name="channelId" value={channel.id} />
            <Button type="submit" variant="outline" size="sm">
              Join
            </Button>
          </form>
        ) : null}
      </div>

      <ul className="flex flex-wrap gap-2">
        {channel.members.map((member) => {
          const removable = mayRemoveFromChannel(currentUser, channel, {
            id: member.id,
            kind: member.kind,
            ownerUserId: member.ownerUserId,
          });
          return (
            <li
              key={member.id}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            >
              <span className={member.kind === 'agent' ? 'text-sky-600' : ''}>
                {member.kind === 'agent' ? '◆ ' : ''}
                {member.name}
              </span>
              {removable ? (
                <form action={removeChannelMemberAction}>
                  <input type="hidden" name="channelId" value={channel.id} />
                  <input type="hidden" name="memberId" value={member.id} />
                  <input type="hidden" name="kind" value={member.kind} />
                  <button
                    type="submit"
                    aria-label={
                      member.id === currentUser.userId ? 'Leave' : `Remove ${member.name}`
                    }
                    title={member.id === currentUser.userId ? 'Leave' : 'Remove'}
                    className="text-muted-foreground hover:text-foreground leading-none"
                  >
                    ×
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      {isMember && addable.length > 0 ? (
        <form action={add} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="channelId" value={channel.id} />
          <select
            name="member"
            className="bg-background h-8 rounded-md border px-2 text-sm"
            defaultValue=""
            required
          >
            <option value="" disabled>
              Add somebody…
            </option>
            {addable.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm" disabled={adding}>
            {adding ? 'Adding…' : 'Add'}
          </Button>
          {!added.ok && added.error ? (
            <span className="text-destructive text-xs" role="alert">
              {added.error}
            </span>
          ) : null}
        </form>
      ) : null}
      {isMember && addableTeams.length > 0 ? (
        <form action={addTeam} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="channelId" value={channel.id} />
          <select
            name="teamId"
            className="bg-background h-8 rounded-md border px-2 text-sm"
            defaultValue=""
            required
          >
            <option value="" disabled>
              Add a team…
            </option>
            {addableTeams.map((team) => (
              <option key={team.id} value={team.id}>
                @{team.name} · {team.members.length}{' '}
                {team.members.length === 1 ? 'agent' : 'agents'}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" size="sm" disabled={addingTeam}>
            {addingTeam ? 'Adding…' : 'Add team'}
          </Button>
          {!teamAdded.ok && teamAdded.error ? (
            <span className="text-destructive text-xs" role="alert">
              {teamAdded.error}
            </span>
          ) : null}
        </form>
      ) : null}
      {isMember && agents.some((a) => a.ownerUserId !== currentUser.userId && !present.has(a.id)) ? (
        <p className="text-muted-foreground text-xs">
          Only an agent&rsquo;s owner can add it here.
        </p>
      ) : null}
    </li>
  );
}
