'use server';

import { mayCreateOfficeCommands, mayEditOfficeCommand, type MembershipRole } from '@quintal/shared';
import {
  OfficeCommandError,
  createOfficeCommand,
  deleteOfficeCommand,
  ensurePersonalWorkspace,
  findMembership,
  getDb,
  getOfficeCommand,
  updateOfficeCommand,
  type OfficeCommandTargetInput,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Making the office's own `!` commands.
 *
 * Two rules, in `office-command.ts`: any member may make one, and its author
 * or an office admin may change or delete it. A command grants nothing a
 * plain message could not, so there is no more to guard than that. The name
 * rule — one word, not a built-in verb, not another command's — is enforced
 * by `createOfficeCommand`/`updateOfficeCommand` and comes back here as an
 * `OfficeCommandError` with a sentence worth showing.
 */

async function caller() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  if (session.session.isGuest) throw new Error('Guests cannot make commands.');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });
  const membership = await findMembership(db, { userId: session.user.id, workspaceId: workspace.id });
  return {
    db,
    workspaceId: workspace.id,
    actor: {
      userId: session.user.id,
      role: (membership?.role as MembershipRole | undefined) ?? null,
    },
  };
}

export interface CommandActionState {
  ok: boolean;
  error?: string;
}

const NOT_YOURS = 'Only whoever made this command, or an office admin, can change it.';

function failed(error: unknown, fallback: string): CommandActionState {
  if (error instanceof OfficeCommandError) return { ok: false, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

/** `agent:<id>`, `team:<id>`, or empty for none — the picker's value. */
function targetFrom(formData: FormData): OfficeCommandTargetInput | null {
  const raw = String(formData.get('defaultTarget') ?? '');
  const match = /^(agent|team):(.+)$/.exec(raw);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as 'agent' | 'team', id: match[2] };
}

export async function createCommandAction(
  _previous: CommandActionState,
  formData: FormData,
): Promise<CommandActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    if (!mayCreateOfficeCommands(actor)) return { ok: false, error: 'Only members of this office can make commands.' };

    await createOfficeCommand(db, {
      workspaceId,
      name: String(formData.get('name') ?? ''),
      summary: String(formData.get('summary') ?? ''),
      argumentHint: String(formData.get('argumentHint') ?? ''),
      instructions: String(formData.get('instructions') ?? ''),
      defaultTarget: targetFrom(formData),
      createdBy: actor.userId,
    });
    revalidatePath('/settings/commands');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not make the command.');
  }
}

export async function updateCommandAction(
  _previous: CommandActionState,
  formData: FormData,
): Promise<CommandActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    const commandId = String(formData.get('commandId') ?? '');
    const command = await getOfficeCommand(db, workspaceId, commandId);
    if (!command) return { ok: false, error: 'No such command.' };
    if (!mayEditOfficeCommand(actor, command)) return { ok: false, error: NOT_YOURS };

    await updateOfficeCommand(db, {
      workspaceId,
      commandId,
      name: String(formData.get('name') ?? ''),
      summary: String(formData.get('summary') ?? ''),
      argumentHint: String(formData.get('argumentHint') ?? ''),
      instructions: String(formData.get('instructions') ?? ''),
      defaultTarget: targetFrom(formData),
      // Saved by hand: whoever is saving read it, so it is theirs again.
      changedByAgentId: null,
    });
    revalidatePath('/settings/commands');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not save the command.');
  }
}

export async function deleteCommandAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  const commandId = String(formData.get('commandId') ?? '');
  const command = await getOfficeCommand(db, workspaceId, commandId);
  if (!command) return;
  if (!mayEditOfficeCommand(actor, command)) throw new Error(NOT_YOURS);

  await deleteOfficeCommand(db, workspaceId, commandId);
  revalidatePath('/settings/commands');
}
