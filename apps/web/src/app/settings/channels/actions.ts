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
  getDb,
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
  const membership = await findMembership(db, session.user.id, workspace.id);
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
    } else if (!(await findMembership(db, memberId, workspaceId))) {
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
