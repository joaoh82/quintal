'use server';

import { mayAddToChannel, mayRemoveFromChannel, type MembershipRole } from '@quintal/shared';
import {
  ChannelNameError,
  addChannelMember,
  createChannel,
  ensurePersonalWorkspace,
  findAgentById,
  findChannel,
  findMembership,
  findTeam,
  getDb,
  isChannelMember,
  removeChannelMember,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Making channels and deciding who is in them.
 *
 * The rules live in `mayAddToChannel` / `mayRemoveFromChannel`, which are
 * pure and tested; this file only gathers the facts they need and applies
 * the answer. The one that matters: an agent joins a channel at its owner's
 * word and nobody else's, because it answers as its owner.
 */

async function caller() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  if (session.session.isGuest) throw new Error('Guests cannot manage channels.');

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

export interface ChannelActionState {
  ok: boolean;
  error?: string;
}

export async function createChannelAction(
  _previous: ChannelActionState,
  formData: FormData,
): Promise<ChannelActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    if (actor.role === null) return { ok: false, error: 'Only members can make channels.' };

    await createChannel(db, {
      workspaceId,
      name: String(formData.get('name') ?? ''),
      createdBy: actor.userId,
    });
    revalidatePath('/settings/channels');
    return { ok: true };
  } catch (error: unknown) {
    if (error instanceof ChannelNameError) return { ok: false, error: error.message };
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not make the channel.',
    };
  }
}

/**
 * Add a person or an agent. `member` is `human:<id>` or `agent:<id>` — one
 * field, because the picker offers both in one list.
 */
export async function addChannelMemberAction(
  _previous: ChannelActionState,
  formData: FormData,
): Promise<ChannelActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    const channelId = String(formData.get('channelId') ?? '');
    const [kind, memberId] = String(formData.get('member') ?? '').split(':', 2);
    if ((kind !== 'human' && kind !== 'agent') || !memberId) {
      return { ok: false, error: 'Pick somebody to add.' };
    }

    const channel = await findChannel(db, workspaceId, channelId);
    if (!channel) return { ok: false, error: 'No such channel.' };

    let ownerUserId: string | null = null;
    if (kind === 'agent') {
      const agent = await findAgentById(db, memberId);
      if (!agent || agent.workspaceId !== workspaceId) return { ok: false, error: 'No such agent.' };
      ownerUserId = agent.ownerUserId;
    } else if (!(await findMembership(db, { userId: memberId, workspaceId }))) {
      return { ok: false, error: 'Not a member of this office.' };
    }

    if (!mayAddToChannel(actor, { id: memberId, kind, ownerUserId })) {
      return {
        ok: false,
        error:
          kind === 'agent'
            ? 'Only an agent’s owner can add it to a channel.'
            : 'You cannot add people to channels.',
      };
    }

    await addChannelMember(db, { channelId, memberId, memberKind: kind, addedBy: actor.userId });
    revalidatePath('/settings/channels');
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not add them.' };
  }
}

/**
 * Put a whole team in a channel: each member that is not already in, one
 * `addChannelMember` at a time, under the same per-owner rule as adding one
 * agent by hand. Members the caller may not add are named in the answer
 * rather than silently skipped — a team half in a channel is a mention that
 * half lands.
 */
export async function addTeamToChannelAction(
  _previous: ChannelActionState,
  formData: FormData,
): Promise<ChannelActionState> {
  try {
    const { db, workspaceId, actor } = await caller();
    const channelId = String(formData.get('channelId') ?? '');
    const teamId = String(formData.get('teamId') ?? '');
    const channel = await findChannel(db, workspaceId, channelId);
    if (!channel) return { ok: false, error: 'No such channel.' };
    const team = await findTeam(db, workspaceId, teamId);
    if (!team) return { ok: false, error: 'No such team.' };

    const refused: string[] = [];
    for (const member of team.members) {
      if (await isChannelMember(db, channelId, member.id)) continue;
      const subject = { id: member.id, kind: 'agent' as const, ownerUserId: member.ownerUserId };
      if (!mayAddToChannel(actor, subject)) {
        refused.push(member.name);
        continue;
      }
      await addChannelMember(db, {
        channelId,
        memberId: member.id,
        memberKind: 'agent',
        addedBy: actor.userId,
      });
    }
    revalidatePath('/settings/channels');
    if (refused.length > 0) {
      return {
        ok: false,
        error: `Added the rest; only an agent’s owner can add ${refused.join(', ')}.`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not add the team.' };
  }
}

export async function removeChannelMemberAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  const channelId = String(formData.get('channelId') ?? '');
  const memberId = String(formData.get('memberId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  if (kind !== 'human' && kind !== 'agent') return;

  const channel = await findChannel(db, workspaceId, channelId);
  if (!channel) return;

  let ownerUserId: string | null = null;
  if (kind === 'agent') {
    const agent = await findAgentById(db, memberId);
    ownerUserId = agent?.ownerUserId ?? null;
  }

  if (!mayRemoveFromChannel(actor, channel, { id: memberId, kind, ownerUserId })) {
    throw new Error('You cannot remove them from this channel.');
  }

  await removeChannelMember(db, channelId, memberId);
  revalidatePath('/settings/channels');
}

/** Join a channel yourself. Same rule as being added: members only. */
export async function joinChannelAction(formData: FormData): Promise<void> {
  const { db, workspaceId, actor } = await caller();
  const channelId = String(formData.get('channelId') ?? '');
  const channel = await findChannel(db, workspaceId, channelId);
  if (!channel) return;
  if (!mayAddToChannel(actor, { id: actor.userId, kind: 'human' })) return;

  await addChannelMember(db, {
    channelId,
    memberId: actor.userId,
    memberKind: 'human',
    addedBy: actor.userId,
  });
  revalidatePath('/settings/channels');
}
