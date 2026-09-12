import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { conversationMembers, conversations } from './schema.js';

/**
 * Where each person is in each conversation.
 *
 * The office's answer to "have I seen this yet", replacing a per-browser one.
 * Unread used to be kept in `localStorage`, which is correct for exactly one
 * browser: open the office on a second machine and every channel that had
 * ever spoken showed a dot, because that browser had never looked at
 * anything. Buzz keeps read state per channel on the wire for the same
 * reason — it is a fact about you, not about the machine you are sitting at.
 *
 * Only channels and DMs. A zone is not a place you catch up on, and nearby is
 * wherever you are standing, so those stay local to the client.
 */

export interface MarkReadInput {
  /** The office, checked: a cursor for a conversation elsewhere is not written. */
  workspaceId: string;
  conversationId: string;
  /** `users.id` or `agents.id`. */
  memberId: string;
  /** When they looked, ms since epoch. */
  at: number;
}

/**
 * Note that somebody has looked, if this is later than where they were.
 *
 * Monotonic by construction rather than by reading first and writing second:
 * two devices reporting out of order must not drag the cursor backwards, and
 * a read-then-write would let them, since the read of the older one can land
 * after the write of the newer.
 *
 * It updates the membership row, so it is also the membership check — a
 * conversation somebody is not in, or one in another office, matches nothing
 * and writes nothing. Returns whether the cursor actually moved, which is
 * what the caller needs to know to decide whether anybody must be told.
 */
export async function markRead(db: Database, input: MarkReadInput): Promise<boolean> {
  const at = new Date(input.at);
  const result = await db
    .update(conversationMembers)
    .set({ lastReadAt: at })
    .where(
      and(
        eq(conversationMembers.conversationId, input.conversationId),
        eq(conversationMembers.memberId, input.memberId),
        // Later than where they were, or they had never looked.
        or(isNull(conversationMembers.lastReadAt), lt(conversationMembers.lastReadAt, at)),
        // The conversation is in this office. A subquery rather than a join:
        // SQLite's UPDATE takes no FROM, and the row is found by primary key
        // either way.
        sql`exists (select 1 from ${conversations} where ${conversations.id} = ${conversationMembers.conversationId} and ${conversations.workspaceId} = ${input.workspaceId})`,
      ),
    );
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * Where one member is in every conversation of theirs in this office.
 *
 * Read once when they arrive. A client that has just connected needs the
 * whole set to decide what to show a dot on, and there are as many rows as
 * they have conversations.
 */
export async function readCursorsForMember(
  db: Database,
  workspaceId: string,
  memberId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      conversationId: conversationMembers.conversationId,
      lastReadAt: conversationMembers.lastReadAt,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.memberId, memberId),
        eq(conversations.workspaceId, workspaceId),
      ),
    );

  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.lastReadAt) out.set(row.conversationId, row.lastReadAt.getTime());
  }
  return out;
}
