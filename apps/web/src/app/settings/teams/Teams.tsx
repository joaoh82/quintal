'use client';

import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  TEAM_NAME_MAX_LENGTH,
  mayManageTeams,
  type MembershipRole,
} from '@quintal/shared';
import type { TeamSummary } from '@quintal/shared/db';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  addTeamMemberAction,
  createTeamAction,
  deleteTeamAction,
  removeTeamMemberAction,
  updateTeamAction,
  type TeamActionState,
} from './actions';

interface TeamsProps {
  teams: TeamSummary[];
  agents: Array<{ id: string; name: string; ownerName: string }>;
  currentUser: { userId: string; role: MembershipRole | null };
}

const IDLE: TeamActionState = { ok: true };

/**
 * Teams and who is on them.
 *
 * A team is a name for several agents: say `@engineering` and every member
 * is addressed at once. Anyone may read this page; only office admins may
 * change it, and the controls say so rather than offering what the action
 * will refuse.
 */
export function Teams({ teams, agents, currentUser }: TeamsProps) {
  const [created, create, creating] = useActionState(createTeamAction, IDLE);
  const canEdit = mayManageTeams(currentUser);

  return (
    <div className="space-y-6">
      {canEdit ? (
        <form action={create} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">New team</span>
              <Input
                name="name"
                placeholder="engineering"
                maxLength={TEAM_NAME_MAX_LENGTH}
                className="w-56"
                required
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">What it does</span>
              <Input
                name="description"
                placeholder="Reviews pull requests and ships fixes"
                maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
                className="w-80"
              />
            </label>
            <Button type="submit" disabled={creating}>
              {creating ? 'Making…' : 'Make team'}
            </Button>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">
              Instructions for every member{' '}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </span>
            <textarea
              name="instructions"
              rows={2}
              maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
              placeholder="Applied to every member of the team, after their own instructions."
              className="bg-background w-full max-w-2xl rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <p className="text-muted-foreground text-xs">
            One word, because it is what people type after @. It cannot be an agent&rsquo;s or
            a person&rsquo;s name.
          </p>
          {!created.ok && created.error ? (
            <p className="text-destructive text-sm" role="alert">
              {created.error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">Only office admins can make or change teams.</p>
      )}

      {teams.length === 0 ? (
        <p className="text-muted-foreground text-sm">No teams yet.</p>
      ) : (
        <ul className="space-y-4">
          {teams.map((team) => (
            <TeamCard key={team.id} team={team} agents={agents} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamCard({
  team,
  agents,
  canEdit,
}: {
  team: TeamSummary;
  agents: TeamsProps['agents'];
  canEdit: boolean;
}) {
  const [added, add, adding] = useActionState(addTeamMemberAction, IDLE);
  const [saved, save, saving] = useActionState(updateTeamAction, IDLE);
  const [editing, setEditing] = useState(false);
  const present = new Set(team.members.map((member) => member.id));
  const addable = agents.filter((agent) => !present.has(agent.id));

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-sm font-medium">@{team.name}</h2>
        {team.description ? (
          <span className="text-muted-foreground text-xs">{team.description}</span>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {team.members.length} {team.members.length === 1 ? 'agent' : 'agents'}
        </span>
        {canEdit ? (
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <form action={deleteTeamAction}>
              <input type="hidden" name="teamId" value={team.id} />
              <Button type="submit" variant="ghost" size="sm" className="text-rose-600">
                Dissolve
              </Button>
            </form>
          </div>
        ) : null}
      </div>

      {editing ? (
        <form action={save} className="space-y-2 rounded-md border border-dashed p-3">
          <input type="hidden" name="teamId" value={team.id} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Name</span>
              <Input name="name" defaultValue={team.name} maxLength={TEAM_NAME_MAX_LENGTH} className="w-56" required />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">What it does</span>
              <Input
                name="description"
                defaultValue={team.description}
                maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
                className="w-80"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Instructions for every member</span>
            <textarea
              name="instructions"
              rows={3}
              defaultValue={team.instructions}
              maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
              className="bg-background w-full max-w-2xl rounded-md border px-3 py-2 text-sm"
            />
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {!saved.ok && saved.error ? (
              <span className="text-destructive text-xs" role="alert">
                {saved.error}
              </span>
            ) : null}
          </div>
        </form>
      ) : team.instructions ? (
        <p className="text-muted-foreground max-w-2xl text-xs whitespace-pre-wrap">
          {team.instructions}
        </p>
      ) : null}

      <ul className="flex flex-wrap gap-2">
        {team.members.length === 0 ? (
          <li className="text-muted-foreground text-xs">Nobody on it yet.</li>
        ) : null}
        {team.members.map((member) => (
          <li
            key={member.id}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
          >
            <span className="text-sky-600">◆ {member.name}</span>
            {canEdit ? (
              <form action={removeTeamMemberAction}>
                <input type="hidden" name="teamId" value={team.id} />
                <input type="hidden" name="agentId" value={member.id} />
                <button
                  type="submit"
                  aria-label={`Remove ${member.name}`}
                  title="Remove"
                  className="text-muted-foreground hover:text-foreground leading-none"
                >
                  ×
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>

      {canEdit && addable.length > 0 ? (
        <form action={add} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="teamId" value={team.id} />
          <select
            name="agentId"
            className="bg-background h-8 rounded-md border px-2 text-sm"
            defaultValue=""
            required
          >
            <option value="" disabled>
              Add an agent…
            </option>
            {addable.map((agent) => (
              <option key={agent.id} value={agent.id}>
                ◆ {agent.name} ({agent.ownerName}&rsquo;s)
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
    </li>
  );
}
