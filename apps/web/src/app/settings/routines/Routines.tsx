'use client';

import {
  ROUTINE_ARGS_MAX_LENGTH,
  ROUTINE_INSTRUCTIONS_MAX_LENGTH,
  ROUTINE_NAME_MAX_LENGTH,
  mayManageRoutine,
  routineWhenPhrase,
  type MembershipRole,
} from '@quintal/shared';
import type { RoutineSummary } from '@quintal/shared/db';
import { useActionState, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RelativeTime } from '@/components/RelativeTime';

import {
  createRoutineAction,
  deleteRoutineAction,
  pauseRoutineAction,
  updateRoutineAction,
  type RoutineActionState,
} from './actions';

interface AgentOption {
  id: string;
  name: string;
}

interface CommandOption {
  id: string;
  name: string;
  summary: string;
}

interface RoutinesProps {
  routines: RoutineSummary[];
  /** The viewer's own agents: the only ones a routine can be put on from here. */
  agents: AgentOption[];
  commands: CommandOption[];
  currentUser: { userId: string; role: MembershipRole | null };
}

const IDLE: RoutineActionState = { ok: true };

/**
 * Routines: a standing request to one of your agents, with a schedule.
 *
 * Every routine in the office is listed, whoever's it is — a routine is
 * read by everybody like a command — but only the agent's owner gets the
 * controls, and the form offers only their agents.
 */
export function Routines({ routines, agents, commands, currentUser }: RoutinesProps) {
  const [created, create, creating] = useActionState(createRoutineAction, IDLE);

  return (
    <div className="space-y-6">
      {agents.length > 0 ? (
        <form action={create} className="space-y-3 rounded-lg border p-4">
          <RoutineFields agents={agents} commands={commands} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={creating}>
              {creating ? 'Making…' : 'Make routine'}
            </Button>
            {!created.ok && created.error ? (
              <p className="text-destructive text-sm" role="alert">
                {created.error}
              </p>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            Nothing tighter than every ten minutes, and at most twenty routines an agent. Times are
            read in your browser’s time zone.
          </p>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">
          You have no agents here to put a routine on. Agents are made in Settings → Agents.
        </p>
      )}

      {routines.length === 0 ? (
        <p className="text-muted-foreground text-sm">No routines yet.</p>
      ) : (
        <ul className="space-y-4">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              agents={agents}
              commands={commands}
              canEdit={mayManageRoutine(currentUser, { ownerUserId: routine.agentOwnerUserId })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The browser's zone, in a hidden field, so "at 9" means 9 where the person is. */
function ZoneField() {
  const [tz, setTz] = useState('UTC');
  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    } catch {
      setTz('UTC');
    }
  }, []);
  return <input type="hidden" name="tz" value={tz} />;
}

/** The same fields to make a routine and to change one. */
function RoutineFields({
  agents,
  commands,
  routine,
}: {
  agents: AgentOption[];
  commands: CommandOption[];
  routine?: RoutineSummary;
}) {
  return (
    <>
      <ZoneField />
      <div className="flex flex-wrap items-end gap-3">
        {routine ? (
          <input type="hidden" name="agentId" value={routine.agentId} />
        ) : (
          <label className="text-sm">
            <span className="mb-1 block font-medium">Agent</span>
            <select name="agentId" className="bg-background h-9 rounded-md border px-2 text-sm" required>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  ◆ {agent.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block font-medium">{routine ? 'Name' : 'New routine'}</span>
          <Input
            name="name"
            placeholder="hourly PR check"
            defaultValue={routine?.name}
            maxLength={ROUTINE_NAME_MAX_LENGTH}
            className="w-56"
            required
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">When</span>
          <Input
            name="when"
            placeholder="every hour · weekdays at 9 · in 45 minutes · 0 9 * * 1-5"
            // A phrase the parser reads back, not the card's label: a changed time in it must save.
            defaultValue={routine ? routineWhenPhrase(routine.schedule) : undefined}
            className="w-80 font-mono"
            required
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            Runs a command <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <select
            name="commandId"
            defaultValue={routine?.command?.id ?? ''}
            className="bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">None: its own instructions</option>
            {commands.map((command) => (
              <option key={command.id} value={command.id}>
                !{command.name}
                {command.summary ? ` — ${command.summary}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            What to give it <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Input
            name="args"
            placeholder="whatever is open in acme/api"
            defaultValue={routine?.args}
            maxLength={ROUTINE_ARGS_MAX_LENGTH}
            className="w-64 font-mono"
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">
          Instructions{' '}
          <span className="text-muted-foreground font-normal">
            (what the routine asks each time; with a command, added after the command’s)
          </span>
        </span>
        <textarea
          name="instructions"
          rows={6}
          defaultValue={routine?.instructions}
          maxLength={ROUTINE_INSTRUCTIONS_MAX_LENGTH}
          placeholder={
            'List the open pull requests in acme/api. For each one without a review from you, read the diff and leave a review. Say here which you reviewed and which you left and why.'
          }
          className="bg-background w-full max-w-2xl rounded-md border px-3 py-2 text-sm"
        />
      </label>
    </>
  );
}

function RoutineCard({
  routine,
  agents,
  commands,
  canEdit,
}: {
  routine: RoutineSummary;
  agents: AgentOption[];
  commands: CommandOption[];
  canEdit: boolean;
}) {
  const [saved, save, saving] = useActionState(updateRoutineAction, IDLE);
  const [editing, setEditing] = useState(false);
  const by = routine.createdByAgentName ? `${routine.createdByName}, via ${routine.createdByAgentName}` : routine.createdByName;

  return (
    <li className={`space-y-3 rounded-lg border p-4 ${routine.paused ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">{routine.name}</h2>
        <span className="text-xs text-sky-700 dark:text-sky-300">◆ {routine.agentName}</span>
        <span className="text-muted-foreground font-mono text-xs">{routine.scheduleLabel}</span>
        {routine.command ? <span className="text-muted-foreground font-mono text-xs">runs !{routine.command.name}</span> : null}
        {routine.paused ? (
          <span className="rounded border border-amber-500/40 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">paused</span>
        ) : null}
        {by ? <span className="text-muted-foreground text-xs">by {by}</span> : null}
        {canEdit ? (
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <form action={pauseRoutineAction}>
              <input type="hidden" name="routineId" value={routine.id} />
              <input type="hidden" name="paused" value={routine.paused ? 'false' : 'true'} />
              <Button type="submit" variant="ghost" size="sm">
                {routine.paused ? 'Resume' : 'Pause'}
              </Button>
            </form>
            <form action={deleteRoutineAction}>
              <input type="hidden" name="routineId" value={routine.id} />
              <Button type="submit" variant="ghost" size="sm" className="text-rose-600">
                Delete
              </Button>
            </form>
          </div>
        ) : null}
      </div>

      <p className="text-muted-foreground text-xs">
        {routine.paused ? (
          'Paused: it will not fire until resumed.'
        ) : routine.nextDueAt !== null ? (
          <>
            Next <RelativeTime at={routine.nextDueAt} />
          </>
        ) : (
          'Done: it has had its moment.'
        )}
        {' · '}
        last ran <RelativeTime at={routine.lastRunAt} never="never" />
      </p>

      {editing ? (
        <form action={save} className="space-y-2 rounded-md border border-dashed p-3">
          <input type="hidden" name="routineId" value={routine.id} />
          <RoutineFields agents={agents} commands={commands} routine={routine} />
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
      ) : routine.instructions ? (
        <p className="text-muted-foreground max-w-2xl text-xs whitespace-pre-wrap">{routine.instructions}</p>
      ) : null}
    </li>
  );
}
