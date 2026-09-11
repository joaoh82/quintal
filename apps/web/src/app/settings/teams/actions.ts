'use server';

import { mayManageTeams, type MembershipRole } from '@quintal/shared';
import {
  TeamNameError,
  addTeamMember,
  createTeam,
  deleteTeam,
  ensurePersonalWorkspace,
  findAgentById,
  findMembership,
  findTeam,
  getDb,
  removeTeamMember,
  updateTeam,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Making teams and deciding who is on them.
 *
 * One rule, in `mayManageTeams`: office admins, and only they. A team is a
 * word that wakes several agents at once, so it is decided by the people
 * who could also revoke those agents. The name rule — one mention token,
 * nobody else's name — is enforced by `createTeam`/`updateTeam` and comes
 * back here as a `TeamNameError` with a sentence worth showing.
 */

async function caller() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  if (session.session.isGuest) throw new Error('Guests cannot manage teams.');

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

export interface TeamActionState {
  ok: boolean;
  error?: string;
}

const NOT_ALLOWED = 'Only office admins can manage teams.';

function failed(error: unknown, fallback: string): TeamActionState {
  if (error instanceof TeamNameError) return { ok: false, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

export async function createTeamAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    if (!mayManageTeams(actor)) return { ok: false, error: NOT_ALLOWED };

    await createTeam(db, {
      workspaceId,
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? ''),
      instructions: String(formData.get('instructions') ?? ''),
      createdBy: actor.userId,
    });
    revalidatePath('/settings/teams');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not make the team.');
  }
}

/** Rename, or change what a team says about itself and to its members. */
export async function updateTeamAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    if (!mayManageTeams(actor)) return { ok: false, error: NOT_ALLOWED };
    const teamId = String(formData.get('teamId') ?? '');
    if (!(await findTeam(db, workspaceId, teamId))) return { ok: false, error: 'No such team.' };

    await updateTeam(db, {
      workspaceId,
      teamId,
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? ''),
      instructions: String(formData.get('instructions') ?? ''),
    });
    revalidatePath('/settings/teams');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not save the team.');
  }
}

export async function addTeamMemberAction(
  _previous: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    if (!mayManageTeams(actor)) return { ok: false, error: NOT_ALLOWED };
    const teamId = String(formData.get('teamId') ?? '');
    const agentId = String(formData.get('agentId') ?? '');
    if (!agentId) return { ok: false, error: 'Pick an agent to add.' };
    if (!(await findTeam(db, workspaceId, teamId))) return { ok: false, error: 'No such team.' };
    const agent = await findAgentById(db, agentId);
    if (!agent || agent.workspaceId !== workspaceId) return { ok: false, error: 'No such agent.' };

    await addTeamMember(db, { workspaceId, teamId, agentId, addedBy: actor.userId });
    revalidatePath('/settings/teams');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not add them.');
  }
}

export async function removeTeamMemberAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  if (!mayManageTeams(actor)) throw new Error(NOT_ALLOWED);
  const teamId = String(formData.get('teamId') ?? '');
  const agentId = String(formData.get('agentId') ?? '');
  if (!(await findTeam(db, workspaceId, teamId))) return;

  await removeTeamMember(db, { workspaceId, teamId, agentId });
  revalidatePath('/settings/teams');
}

/** Dissolve a team. The agents on it are untouched. */
export async function deleteTeamAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  if (!mayManageTeams(actor)) throw new Error(NOT_ALLOWED);
  const teamId = String(formData.get('teamId') ?? '');

  await deleteTeam(db, workspaceId, teamId);
  revalidatePath('/settings/teams');
}
