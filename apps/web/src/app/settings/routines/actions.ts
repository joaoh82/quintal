'use server';

import { mayManageRoutine, parseRoutineWhen, routineWhenPhrase, type MembershipRole } from '@quintal/shared';
import {
  RoutineError,
  createRoutine,
  deleteRoutine,
  ensurePersonalWorkspace,
  findAgentById,
  findMembership,
  getDb,
  getRoutine,
  updateRoutine,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Making routines from Settings.
 *
 * One rule, in `routine.ts`: the agent's owner, and nobody else. The
 * schedule is read from what was typed ("weekdays at 9", "in 45 minutes",
 * a cron line) in the zone the browser said it was in, and refused with a
 * sentence worth showing when it cannot be.
 */

async function caller() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  if (session.session.isGuest) throw new Error('Guests cannot make routines.');

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

export interface RoutineActionState {
  ok: boolean;
  error?: string;
}

const NOT_YOURS = 'Only the agent’s owner puts a routine on it, changes it or takes it off.';

function failed(error: unknown, fallback: string): RoutineActionState {
  if (error instanceof RoutineError) return { ok: false, error: error.message };
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '');
}

/** The browser's zone rides in a hidden field; a form without one is read in UTC and the label says so. */
function zoneOf(formData: FormData): string {
  const tz = text(formData, 'tz').trim();
  return tz.length > 0 ? tz : 'UTC';
}

export async function createRoutineAction(_previous: RoutineActionState, formData: FormData): Promise<RoutineActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    const agentId = text(formData, 'agentId');
    const agent = await findAgentById(db, agentId);
    if (!agent || agent.workspaceId !== workspaceId) return { ok: false, error: 'Pick one of your agents.' };
    if (!mayManageRoutine(actor, agent)) return { ok: false, error: NOT_YOURS };
    const when = parseRoutineWhen(text(formData, 'when'), { now: Date.now(), tz: zoneOf(formData) });
    if (!when.ok) return { ok: false, error: when.error };
    const commandId = text(formData, 'commandId');
    await createRoutine(db, {
      workspaceId,
      agentId,
      name: text(formData, 'name'),
      schedule: when.schedule,
      instructions: text(formData, 'instructions'),
      commandId: commandId.length > 0 ? commandId : null,
      args: text(formData, 'args'),
      createdBy: actor.userId,
      now: Date.now(),
    });
    revalidatePath('/settings/routines');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not make the routine.');
  }
}

export async function updateRoutineAction(_previous: RoutineActionState, formData: FormData): Promise<RoutineActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    const routineId = text(formData, 'routineId');
    const routine = await getRoutine(db, workspaceId, routineId);
    if (!routine) return { ok: false, error: 'No such routine.' };
    if (!mayManageRoutine(actor, { ownerUserId: routine.agentOwnerUserId })) return { ok: false, error: NOT_YOURS };
    // The schedule is re-read only when the words changed from what the box
    // was filled with: a save that left them must not restart the clock.
    const when = text(formData, 'when').trim();
    let schedule = undefined;
    if (when.length > 0 && when !== routineWhenPhrase(routine.schedule)) {
      const parsed = parseRoutineWhen(when, { now: Date.now(), tz: zoneOf(formData) });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      schedule = parsed.schedule;
    }
    const commandId = text(formData, 'commandId');
    await updateRoutine(db, {
      workspaceId,
      routineId,
      name: text(formData, 'name'),
      ...(schedule ? { schedule } : {}),
      instructions: text(formData, 'instructions'),
      commandId: commandId.length > 0 ? commandId : null,
      args: text(formData, 'args'),
      now: Date.now(),
    });
    revalidatePath('/settings/routines');
    return { ok: true };
  } catch (error: unknown) {
    return failed(error, 'Could not save the routine.');
  }
}

/** Pause or resume. A resume sets the next slot from now. */
export async function pauseRoutineAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  const routineId = text(formData, 'routineId');
  const routine = await getRoutine(db, workspaceId, routineId);
  if (!routine) return;
  if (!mayManageRoutine(actor, { ownerUserId: routine.agentOwnerUserId })) throw new Error(NOT_YOURS);
  await updateRoutine(db, { workspaceId, routineId, paused: text(formData, 'paused') === 'true', now: Date.now() });
  revalidatePath('/settings/routines');
}

export async function deleteRoutineAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  const routineId = text(formData, 'routineId');
  const routine = await getRoutine(db, workspaceId, routineId);
  if (!routine) return;
  if (!mayManageRoutine(actor, { ownerUserId: routine.agentOwnerUserId })) throw new Error(NOT_YOURS);
  await deleteRoutine(db, workspaceId, routineId);
  revalidatePath('/settings/routines');
}
