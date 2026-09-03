import { randomBytes } from 'node:crypto';

import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';

import { FLOOR_ZONE_ID, FLOOR_ZONE_LABEL } from '../conversation.js';
import type { PlayerKind } from '../player.js';
import type { Database } from './client.js';
import { conversations, messageMentions, messages } from './schema.js';

/**
 * What was said, kept.
 *
 * Chat used to live in a 200-entry array on the room, which was gone when the
 * room was, and which erased a person's lines the moment they disconnected.
 * This is the durable version: one row per message, one transcript per zone,
 * scoped to an office by a column every reader filters on.
 *
 * Two reads matter and both are indexed: a conversation's transcript, newest
 * first, paged by time; and the messages that named a particular person,
 * because a mention reaches across the map and is the only way something said
 * out of earshot can later be found by the one it was for.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Make sure every zone on a map has a transcript in this office, and say
 * which row is which.
 *
 * Called when a room opens. Idempotent: a zone already present keeps its id
 * and its history, and only its label is brought up to date — maps are edited,
 * transcripts are not. The implicit floor zone is created alongside, so words
 * said in a corridor have somewhere to go.
 */
export async function ensureZoneConversations(
  db: Database,
  workspaceId: string,
  mapId: string,
  zones: ReadonlyArray<{ id: string; label: string }>,
): Promise<Map<string, string>> {
  const wanted = [...zones, { id: FLOOR_ZONE_ID, label: FLOOR_ZONE_LABEL }];

  for (const zone of wanted) {
    await db
      .insert(conversations)
      .values({
        id: newId(),
        workspaceId,
        kind: 'zone',
        mapId,
        zoneId: zone.id,
        name: zone.label,
      })
      .onConflictDoUpdate({
        target: [conversations.workspaceId, conversations.mapId, conversations.zoneId],
        set: { name: zone.label },
      });
  }

  const rows = await db
    .select({ id: conversations.id, zoneId: conversations.zoneId })
    .from(conversations)
    .where(
      and(
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.kind, 'zone'),
        eq(conversations.mapId, mapId),
      ),
    );

  const byZone = new Map<string, string>();
  for (const row of rows) if (row.zoneId !== null) byZone.set(row.zoneId, row.id);
  return byZone;
}

export interface RecordMessageInput {
  conversationId: string;
  fromId: string;
  fromKind: PlayerKind;
  fromName: string;
  text: string;
  sentAt: number;
  /** Map pixels. Omit for conversations that have no "where". */
  x?: number;
  y?: number;
  /** Stable ids (`users.id` / `agents.id`) of everyone addressed by name. */
  mentions?: readonly string[];
}

/**
 * Keep one message. Returns its id.
 *
 * The office is derived from the conversation in the same statement rather
 * than passed in: a caller that had to supply it could supply the wrong one,
 * and a subquery against the conversation being written to cannot.
 *
 * The mention rows follow in a second statement, not a transaction — libSQL
 * over HTTP does not make transactions free, and the failure between the two
 * is a message without its mention index, which is a message that is merely
 * harder to find rather than one that is lost.
 */
export async function recordMessage(db: Database, input: RecordMessageInput): Promise<string> {
  const id = newId();

  await db.insert(messages).values({
    id,
    workspaceId: sql`(select ${conversations.workspaceId} from ${conversations} where ${conversations.id} = ${input.conversationId})`,
    conversationId: input.conversationId,
    fromId: input.fromId,
    fromKind: input.fromKind,
    fromName: input.fromName,
    text: input.text,
    sentAt: new Date(input.sentAt),
    x: input.x === undefined ? null : Math.round(input.x),
    y: input.y === undefined ? null : Math.round(input.y),
  });

  const mentioned = [...new Set(input.mentions ?? [])].filter((member) => member.length > 0);
  if (mentioned.length > 0) {
    await db
      .insert(messageMentions)
      .values(mentioned.map((memberId) => ({ messageId: id, memberId })))
      .onConflictDoNothing();
  }

  return id;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  fromId: string;
  fromKind: PlayerKind;
  fromName: string;
  text: string;
  sentAt: number;
  x: number | null;
  y: number | null;
}

export interface MessagePage {
  /** Oldest first — the order a transcript is read in. */
  messages: StoredMessage[];
  /** There is more before the first message here. */
  hasMore: boolean;
}

export interface MessageQuery {
  workspaceId: string;
  /** Clamped to [1, 200]. */
  limit?: number;
  /** Only messages sent strictly before this time (ms since epoch). */
  before?: number;
}

const selection = {
  id: messages.id,
  conversationId: messages.conversationId,
  fromId: messages.fromId,
  fromKind: messages.fromKind,
  fromName: messages.fromName,
  text: messages.text,
  sentAt: messages.sentAt,
  x: messages.x,
  y: messages.y,
};

function pageOf(
  rows: Array<Omit<StoredMessage, 'sentAt'> & { sentAt: Date }>,
  limit: number,
): MessagePage {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => ({ ...row, sentAt: row.sentAt.getTime() }));
  page.reverse();
  return { messages: page, hasMore };
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}

/** A conversation's transcript, newest `limit` messages, oldest first. */
export async function recentMessages(
  db: Database,
  conversationId: string,
  query: MessageQuery,
): Promise<MessagePage> {
  const limit = clampLimit(query.limit);
  const rows = await db
    .select(selection)
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.workspaceId, query.workspaceId),
        query.before === undefined ? undefined : lt(messages.sentAt, new Date(query.before)),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(limit + 1);
  return pageOf(rows, limit);
}

export interface NearbyQuery extends MessageQuery {
  mapId: string;
  /** Where the listener stands, in map pixels. */
  x: number;
  y: number;
  /** In map pixels. */
  radius: number;
}

/**
 * What somebody standing here could have heard, across every zone on the map.
 *
 * Earshot does not stop at a zone's edge — a conversation held by a doorway is
 * half in the room and half in the corridor — so this reads by distance and
 * ignores which transcript a message landed in.
 */
export async function recentMessagesNear(db: Database, query: NearbyQuery): Promise<MessagePage> {
  const limit = clampLimit(query.limit);
  const radius = Math.max(0, query.radius);
  const px = Math.round(query.x);
  const py = Math.round(query.y);

  const rows = await db
    .select(selection)
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.workspaceId, query.workspaceId),
        eq(conversations.mapId, query.mapId),
        isNotNull(messages.x),
        isNotNull(messages.y),
        sql`(${messages.x} - ${px}) * (${messages.x} - ${px}) + (${messages.y} - ${py}) * (${messages.y} - ${py}) <= ${radius * radius}`,
        query.before === undefined ? undefined : lt(messages.sentAt, new Date(query.before)),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(limit + 1);
  return pageOf(rows, limit);
}

/** Messages that addressed this person or agent by name, newest `limit`, oldest first. */
export async function mentionsOf(
  db: Database,
  memberId: string,
  query: MessageQuery,
): Promise<MessagePage> {
  const limit = clampLimit(query.limit);
  const rows = await db
    .select(selection)
    .from(messageMentions)
    .innerJoin(messages, eq(messages.id, messageMentions.messageId))
    .where(
      and(
        eq(messageMentions.memberId, memberId),
        eq(messages.workspaceId, query.workspaceId),
        query.before === undefined ? undefined : lt(messages.sentAt, new Date(query.before)),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(limit + 1);
  return pageOf(rows, limit);
}
