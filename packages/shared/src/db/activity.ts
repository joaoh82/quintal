import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { activityText, parseActivity, type PublicActivity } from '../activity.js';
import type { Database } from './client.js';
import { agentActivity, conversations } from './schema.js';

export async function keepActivity(
  db: Database,
  conversationId: string,
  workspaceId: string,
  activity: PublicActivity,
  position: { x: number; y: number } | null,
): Promise<void> {
  const row = {
    id: `${workspaceId}:${activity.agentId}:${activity.turnId}`,
    workspaceId,
    conversationId,
    agentId: activity.agentId,
    sequence: activity.sequence,
    startedAt: activity.startedAt,
    x: position?.x ?? null,
    y: position?.y ?? null,
    snapshot: JSON.stringify(activity),
  };
  await db
    .insert(agentActivity)
    .values(row)
    .onConflictDoUpdate({
      target: agentActivity.id,
      set: { sequence: row.sequence, snapshot: row.snapshot },
      setWhere: and(
        eq(agentActivity.workspaceId, workspaceId),
        eq(agentActivity.conversationId, conversationId),
        sql`(${agentActivity.sequence} < ${activity.sequence} OR
        (${agentActivity.sequence} = ${activity.sequence} AND json_extract(${agentActivity.snapshot}, '$.receivedAt') <= ${activity.receivedAt}))`,
      ),
    });
}
export async function readActivity(
  db: Database,
  workspaceId: string,
  target: {
    conversationId?: string;
    mapId: string;
    x: number;
    y: number;
    radius: number;
    before?: number;
  },
): Promise<PublicActivity[]> {
  const rows = await db
    .select({ activity: agentActivity })
    .from(agentActivity)
    .innerJoin(conversations, eq(agentActivity.conversationId, conversations.id))
    .where(
      and(
        eq(agentActivity.workspaceId, workspaceId),
        target.before ? lt(agentActivity.startedAt, target.before) : undefined,
        target.conversationId
          ? eq(agentActivity.conversationId, target.conversationId)
          : and(
              eq(conversations.mapId, target.mapId),
              eq(conversations.kind, 'zone'),
              sql`(${agentActivity.x} - ${target.x}) * (${agentActivity.x} - ${target.x}) +
          (${agentActivity.y} - ${target.y}) * (${agentActivity.y} - ${target.y}) <= ${target.radius * target.radius}`,
            ),
      ),
    )
    .orderBy(desc(agentActivity.startedAt))
    .limit(50);
  return rows.reverse().flatMap((row) => {
    const value = decodeActivity(row.activity);
    return value ? [value] : [];
  });
}

export async function findActivity(
  db: Database,
  workspaceId: string,
  agentId: string,
  turnId: string,
) {
  const [row] = await db
    .select()
    .from(agentActivity)
    .where(
      and(
        eq(agentActivity.workspaceId, workspaceId),
        eq(agentActivity.id, `${workspaceId}:${agentId}:${turnId}`),
      ),
    );
  if (!row) return undefined;
  const activity = decodeActivity(row);
  const { snapshot: _snapshot, ...metadata } = row;
  return activity ? { ...metadata, activity } : undefined;
}

/** Durable storage is a trust boundary too: reject corrupt rows and strip future fields. */
function decodeActivity(row: typeof agentActivity.$inferSelect): PublicActivity | null {
  try {
    const raw = JSON.parse(row.snapshot) as PublicActivity;
    if (!raw || typeof raw !== 'object') return null;
    const { agentId, agentName, receivedAt, nearby: _nearby, ...snapshot } = raw;
    const value = parseActivity(snapshot);
    if (
      !value ||
      agentId !== row.agentId ||
      typeof agentName !== 'string' ||
      !Number.isSafeInteger(receivedAt) ||
      receivedAt < 0 ||
      value.sequence !== row.sequence ||
      value.startedAt !== row.startedAt ||
      row.id !== `${row.workspaceId}:${agentId}:${value.turnId}`
    )
      return null;
    return { ...value, agentId, agentName: activityText(agentName, 120), receivedAt };
  } catch {
    return null;
  }
}
