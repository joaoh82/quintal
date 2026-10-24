'use client';

import {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  OFFICE_COMMAND_ARGUMENT_HINT_MAX_LENGTH,
  OFFICE_COMMAND_NAME_MAX_LENGTH,
  OFFICE_COMMAND_SUMMARY_MAX_LENGTH,
  mayCreateOfficeCommands,
  mayEditOfficeCommand,
  officeCommandUsage,
  type MembershipRole,
} from '@quintal/shared';
import type { OfficeCommandSummary } from '@quintal/shared/db';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  createCommandAction,
  deleteCommandAction,
  updateCommandAction,
  type CommandActionState,
} from './actions';

/** An agent or a team a command can default to: `agent:<id>` / `team:<id>`. */
interface TargetOption {
  value: string;
  label: string;
}

interface CommandsProps {
  commands: OfficeCommandSummary[];
  targets: TargetOption[];
  currentUser: { userId: string; role: MembershipRole | null };
}

const IDLE: CommandActionState = { ok: true };

/**
 * The office's own `!` commands.
 *
 * A command is a word, a line for the picker, what to type after it, and
 * the brief every agent it reaches is given. Any member may make one; its
 * author or an admin may change it, and the controls say so rather than
 * offering what the action will refuse.
 */
export function Commands({ commands, targets, currentUser }: CommandsProps) {
  const [created, create, creating] = useActionState(createCommandAction, IDLE);
  const canCreate = mayCreateOfficeCommands(currentUser);

  return (
    <div className="space-y-6">
      {canCreate ? (
        <form action={create} className="space-y-3 rounded-lg border p-4">
          <CommandFields targets={targets} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={creating}>
              {creating ? 'Making…' : 'Make command'}
            </Button>
            {!created.ok && created.error ? (
              <p className="text-destructive text-sm" role="alert">
                {created.error}
              </p>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            One word, because it is what people type after !. The built-in ones — !cancel,
            !task and the rest — are taken.
          </p>
        </form>
      ) : (
        <p className="text-muted-foreground text-sm">Only members of this office can make commands.</p>
      )}

      {commands.length === 0 ? (
        <p className="text-muted-foreground text-sm">No commands yet.</p>
      ) : (
        <ul className="space-y-4">
          {commands.map((command) => (
            <CommandCard
              key={command.id}
              command={command}
              targets={targets}
              canEdit={mayEditOfficeCommand(currentUser, command)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The same fields to make a command and to change one. */
function CommandFields({
  targets,
  command,
}: {
  targets: TargetOption[];
  command?: OfficeCommandSummary;
}) {
  const current = command?.defaultTarget
    ? `${command.defaultTarget.kind}:${command.defaultTarget.id}`
    : '';
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium">{command ? 'Name' : 'New command'}</span>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground font-mono">!</span>
            <Input
              name="name"
              placeholder="review"
              defaultValue={command?.name}
              maxLength={OFFICE_COMMAND_NAME_MAX_LENGTH}
              className="w-40 font-mono"
              required
            />
          </div>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">What it does</span>
          <Input
            name="summary"
            placeholder="Review a pull request"
            defaultValue={command?.summary}
            maxLength={OFFICE_COMMAND_SUMMARY_MAX_LENGTH}
            className="w-72"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            What to type after it <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <Input
            name="argumentHint"
            placeholder="<pull request link>"
            defaultValue={command?.argumentHint}
            maxLength={OFFICE_COMMAND_ARGUMENT_HINT_MAX_LENGTH}
            className="w-56 font-mono"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">
            When nobody is named <span className="text-muted-foreground font-normal">(optional)</span>
          </span>
          <select
            name="defaultTarget"
            defaultValue={current}
            className="bg-background h-9 rounded-md border px-2 text-sm"
          >
            <option value="">Whoever is near</option>
            {targets.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Instructions for whoever it reaches</span>
        <textarea
          name="instructions"
          rows={4}
          defaultValue={command?.instructions}
          maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
          placeholder={
            'Check out the branch and read the whole diff. Run the tests. Comment on the pull request with what would break, then what is merely untidy, and approve only if nothing would break.'
          }
          className="bg-background w-full max-w-2xl rounded-md border px-3 py-2 text-sm"
        />
      </label>
    </>
  );
}

function CommandCard({
  command,
  targets,
  canEdit,
}: {
  command: OfficeCommandSummary;
  targets: TargetOption[];
  canEdit: boolean;
}) {
  const [saved, save, saving] = useActionState(updateCommandAction, IDLE);
  const [editing, setEditing] = useState(false);

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-sm font-medium">{officeCommandUsage(command)}</h2>
        {command.summary ? (
          <span className="text-muted-foreground text-xs">{command.summary}</span>
        ) : null}
        {command.createdByName ? (
          <span className="text-muted-foreground text-xs">by {command.createdByName}</span>
        ) : null}
        {canEdit ? (
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing((on) => !on)}>
              {editing ? 'Close' : 'Edit'}
            </Button>
            <form action={deleteCommandAction}>
              <input type="hidden" name="commandId" value={command.id} />
              <Button type="submit" variant="ghost" size="sm" className="text-rose-600">
                Delete
              </Button>
            </form>
          </div>
        ) : null}
      </div>

      {editing ? (
        <form action={save} className="space-y-2 rounded-md border border-dashed p-3">
          <input type="hidden" name="commandId" value={command.id} />
          <CommandFields targets={targets} command={command} />
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
      ) : command.instructions ? (
        <p className="text-muted-foreground max-w-2xl text-xs whitespace-pre-wrap">
          {command.instructions}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">No instructions: the line is passed on as asked.</p>
      )}
    </li>
  );
}
