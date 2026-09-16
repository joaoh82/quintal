import { activityDetailLevel, type ActivityDetailLevel } from '../activity.js';
import type { Database } from './client.js';
import { users } from './schema.js';
import { eq } from 'drizzle-orm';

/** Presentation preferences owned by one account, independent of an office. */
export async function getUserActivityDetailLevel(
  db: Database,
  userId: string,
): Promise<ActivityDetailLevel> {
  const row = (
    await db
      .select({ level: users.activityDetailLevel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  return activityDetailLevel(row?.level);
}

export async function setUserActivityDetailLevel(
  db: Database,
  userId: string,
  level: ActivityDetailLevel,
): Promise<void> {
  await db
    .update(users)
    .set({ activityDetailLevel: level })
    .where(eq(users.id, userId));
}
