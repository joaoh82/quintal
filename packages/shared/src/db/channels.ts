import { randomBytes } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  CHANNEL_NAME_MAX_LENGTH,
  channelSlug,
  dmKey,
  type ChannelRef,
  type ConversationKind,
} from '../conversation.js';
import { displayName } from '../identity.js';
import type { PlayerKind } from '../player.js';
import type { Database } from './client.js';
import { agents, conversationMembers, conversations, memberships, users } from './schema.js';

/**
 * Channels: conversations that name their members.
 *
 * A channel is a `conversations` row of kind `channel` plus rows in
 * `conversation_members`. Nothing about the message path is different from a
 * zone — the same `messages` table, the same readers — which is the point of
 * having one table for every shape of conversation. What differs is who is
 * told, and that is decided by the rows here.
 *
 * The rules for who may add and remove whom are pure functions in
 * `conversation.ts`, so a page and a room can ask the same question and so a
 * test can ask it without a database.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

export class ChannelNameError extends Error {
  constructor(
    readonly reason: 'invalid' | 'taken',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelNameError';
  }
}

export interface ChannelMember {
  id: string;
  kind: PlayerKind;
  name: string;
  /** For an agent, the person accountable for it. Null for people. */
  ownerUserId: string | null;
  addedBy: string;
}

export interface ChannelSummary extends ChannelRef {
  workspaceId: string;
  createdBy: string | null;
  createdAt: number;
  members: ChannelMember[];
}

/**
 * Make a channel, with its maker as the first member.
 *
 * Two statements rather than a transaction, for the reason given on
 * `recordMessage`: the failure between them is a channel with nobody in it,
 * which its maker can join, not a channel that half exists.
 */
export async function createChannel(
  db: Database,
  input: { workspaceId: string; name: string; createdBy: string },
): Promise<ChannelRef> {
  const name = input.name.trim().slice(0, CHANNEL_NAME_MAX_LENGTH);
  const slug = channelSlug(name);
  if (slug.length === 0) {
    throw new ChannelNameError('invalid', 'A channel needs a name with a letter or digit in it.');
  }

  const taken = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.slug, slug)))
    .limit(1);
  if (taken.length > 0) {
    throw new ChannelNameError('taken', `There is already a #${slug} channel.`);
  }

  const id = newId();
  await db.insert(conversations).values({
    id,
    workspaceId: input.workspaceId,
    kind: 'channel',
    name,
    slug,
    createdBy: input.createdBy,
  });
  await db.insert(conversationMembers).values({
    conversationId: id,
    memberId: input.createdBy,
    memberKind: 'human',
    addedBy: input.createdBy,
  });

  return { id, kind: 'channel', name, slug };
}

/**
 * Open — or find — the direct message between two members.
 *
 * A DM is a conversation of kind `dm` whose `slug` is `dmKey(a, b)`, so the
 * same pair always lands on the same row whichever of them asks. Members are
 * fixed at creation: the two of them. It is never listed where channels are.
 *
 * Authorisation is the caller's — `mayOpenDm` — for the usual reason: this
 * function does not know who is asking, only who is being connected.
 */
export async function openDm(
  db: Database,
  input: {
    workspaceId: string;
    openerId: string;
    other: { id: string; kind: PlayerKind };
  },
): Promise<{ id: string; created: boolean }> {
  const key = dmKey(input.openerId, input.other.id);

  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.slug, key)))
    .limit(1);

  let id = existing[0]?.id;
  const created = id === undefined;
  if (id === undefined) {
    id = newId();
    await db
      .insert(conversations)
      .values({
        id,
        workspaceId: input.workspaceId,
        kind: 'dm',
        name: '',
        slug: key,
        createdBy: input.openerId,
      })
      .onConflictDoNothing();
    // Lost a race to the other party opening the same DM: take theirs.
    const won = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.slug, key)))
      .limit(1);
    id = won[0]?.id ?? id;
  }

  await db
    .insert(conversationMembers)
    .values([
      { conversationId: id, memberId: input.openerId, memberKind: 'human', addedBy: input.openerId },
      {
        conversationId: id,
        memberId: input.other.id,
        memberKind: input.other.kind,
        addedBy: input.openerId,
      },
    ])
    .onConflictDoNothing();

  return { id, created };
}

export async function findChannel(
  db: Database,
  workspaceId: string,
  channelId: string,
): Promise<(ChannelRef & { createdBy: string | null }) | null> {
  const rows = await db
    .select({
      id: conversations.id,
      name: conversations.name,
      slug: conversations.slug,
      createdBy: conversations.createdBy,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, channelId),
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.kind, 'channel'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.slug === null) return null;
  return { id: row.id, kind: 'channel', name: row.name, slug: row.slug, createdBy: row.createdBy };
}

/**
 * Everyone in a set of channels, with their names resolved.
 *
 * Names come from the `users` and `agents` tables at read time rather than
 * being copied into the membership row: a member who renames themselves is
 * still the same member. Messages snapshot the name; membership does not.
 */
async function membersOf(
  db: Database,
  channelIds: readonly string[],
): Promise<Map<string, ChannelMember[]>> {
  const byChannel = new Map<string, ChannelMember[]>();
  if (channelIds.length === 0) return byChannel;

  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      memberId: conversationMembers.memberId,
      memberKind: conversationMembers.memberKind,
      addedBy: conversationMembers.addedBy,
      addedAt: conversationMembers.addedAt,
      userName: users.name,
      userPubkey: users.pubkey,
      agentName: agents.name,
      agentOwner: agents.ownerUserId,
    })
    .from(conversationMembers)
    .leftJoin(
      users,
      and(eq(users.id, conversationMembers.memberId), eq(conversationMembers.memberKind, 'human')),
    )
    .leftJoin(
      agents,
      and(eq(agents.id, conversationMembers.memberId), eq(conversationMembers.memberKind, 'agent')),
    )
    .where(inArray(conversationMembers.conversationId, [...channelIds]))
    // Two members added in the same millisecond — the maker and the first
    // agent, typically — would otherwise come back in whichever order the
    // planner felt like, and a list that reorders itself between renders is
    // a list people misclick on.
    .orderBy(asc(conversationMembers.addedAt), asc(conversationMembers.memberId));

  for (const row of rows) {
    const list = byChannel.get(row.conversationId) ?? [];
    const name =
      row.memberKind === 'agent'
        ? (row.agentName ?? 'a removed agent')
        : row.userPubkey
          ? displayName({ name: row.userName, pubkey: row.userPubkey })
          : 'a removed account';
    list.push({
      id: row.memberId,
      kind: row.memberKind,
      name,
      ownerUserId: row.memberKind === 'agent' ? (row.agentOwner ?? null) : null,
      addedBy: row.addedBy,
    });
    byChannel.set(row.conversationId, list);
  }
  return byChannel;
}

/**
 * Every channel in an office, with members. For the settings page — which is
 * why DMs are not in it: a DM is a channel nobody can find, and "nobody" has
 * to include the office's admin page, or it is not private.
 */
export async function listChannels(db: Database, workspaceId: string): Promise<ChannelSummary[]> {
  return listConversationsWithMembers(db, workspaceId, ['channel']);
}

async function listConversationsWithMembers(
  db: Database,
  workspaceId: string,
  kinds: readonly Exclude<ConversationKind, 'zone'>[],
): Promise<ChannelSummary[]> {
  const rows = await db
    .select({
      id: conversations.id,
      kind: conversations.kind,
      name: conversations.name,
      slug: conversations.slug,
      createdBy: conversations.createdBy,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), inArray(conversations.kind, [...kinds])))
    .orderBy(asc(conversations.createdAt));

  const members = await membersOf(
    db,
    rows.map((row) => row.id),
  );

  return rows
    .filter(
      (row): row is typeof row & { slug: string; kind: 'channel' | 'dm' } =>
        row.slug !== null && row.kind !== 'zone',
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      workspaceId,
      name: row.name,
      // A DM's slug is its pair key, which is an identifier and not a name;
      // nothing should ever print it.
      slug: row.kind === 'dm' ? '' : row.slug,
      createdBy: row.createdBy,
      createdAt: row.createdAt.getTime(),
      members: members.get(row.id) ?? [],
    }));
}

/**
 * Membership of every channel *and DM* in an office, keyed by conversation —
 * what a room needs to decide who is told about a message, in one query
 * rather than one per line said. DMs are here because the room delivers
 * them; the settings page does not get this list.
 */
export async function channelMembershipForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<Map<string, ChannelRef & { members: Map<string, ChannelMember> }>> {
  const all = await listConversationsWithMembers(db, workspaceId, ['channel', 'dm']);
  const out = new Map<string, ChannelRef & { members: Map<string, ChannelMember> }>();
  for (const conversation of all) {
    out.set(conversation.id, {
      id: conversation.id,
      kind: conversation.kind,
      name: conversation.name,
      slug: conversation.slug,
      members: new Map(conversation.members.map((member) => [member.id, member])),
    });
  }
  return out;
}

/** The channels one person or agent is in, in this office. */
export async function listChannelsForMember(
  db: Database,
  workspaceId: string,
  memberId: string,
): Promise<ChannelRef[]> {
  const rows = await db
    .select({ id: conversations.id, name: conversations.name, slug: conversations.slug })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.memberId, memberId),
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.kind, 'channel'),
      ),
    )
    .orderBy(asc(conversations.createdAt));
  return rows
    .filter((row): row is typeof row & { slug: string } => row.slug !== null)
    .map((row) => ({ id: row.id, kind: 'channel' as const, name: row.name, slug: row.slug }));
}

export async function isChannelMember(
  db: Database,
  channelId: string,
  memberId: string,
): Promise<boolean> {
  const rows = await db
    .select({ memberId: conversationMembers.memberId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, channelId),
        eq(conversationMembers.memberId, memberId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Put somebody in a channel. Idempotent: adding a member twice is one
 * membership, and the first `addedBy` is the one that stands.
 *
 * Authorisation is the caller's job — `mayAddToChannel` — because the caller
 * is the one that knows who is asking.
 */
export async function addChannelMember(
  db: Database,
  input: { channelId: string; memberId: string; memberKind: PlayerKind; addedBy: string },
): Promise<void> {
  await db
    .insert(conversationMembers)
    .values({
      conversationId: input.channelId,
      memberId: input.memberId,
      memberKind: input.memberKind,
      addedBy: input.addedBy,
    })
    .onConflictDoNothing();
}

export async function removeChannelMember(
  db: Database,
  channelId: string,
  memberId: string,
): Promise<void> {
  await db
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, channelId),
        eq(conversationMembers.memberId, memberId),
      ),
    );
}

/** The people in an office, for picking who to add. */
export async function listPeopleForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<Array<{ id: string; name: string; role: string }>> {
  const rows = await db
    .select({ id: users.id, name: users.name, pubkey: users.pubkey, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.workspaceId, workspaceId));
  return rows.map((row) => ({
    id: row.id,
    name: displayName({ name: row.name, pubkey: row.pubkey }),
    role: row.role,
  }));
}
