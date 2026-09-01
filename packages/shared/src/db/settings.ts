import { asc, eq } from 'drizzle-orm';

import {
  DEFAULT_INSTANCE_SETTINGS,
  DEFAULT_OFFICE_SETTINGS,
  normaliseInstanceSettings,
  normaliseSettings,
  type InstanceSettings,
  type OfficeSettings,
} from '../settings.js';
import type { Database } from './client.js';
import { instanceSettings, officeSettings, users } from './schema.js';

/** The single instance-settings row. There is exactly one, and this is its id. */
const GLOBAL = 'global';

export async function getInstanceSettings(db: Database): Promise<InstanceSettings> {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, GLOBAL))
    .limit(1);

  const row = rows[0];
  if (!row) return { ...DEFAULT_INSTANCE_SETTINGS };
  return normaliseInstanceSettings({ name: row.name });
}

export async function saveInstanceSettings(
  db: Database,
  input: Partial<InstanceSettings>,
): Promise<InstanceSettings> {
  const current = await getInstanceSettings(db);
  const next = normaliseInstanceSettings({ ...current, ...input });

  await db
    .insert(instanceSettings)
    .values({ id: GLOBAL, ...next })
    .onConflictDoUpdate({ target: instanceSettings.id, set: { ...next, updatedAt: new Date() } });

  return next;
}

/**
 * How one office's room behaves.
 *
 * No row means defaults: an office does not need one until somebody changes
 * something, and a missing row must never mean a room with a chat radius of
 * zero where nobody can hear anybody.
 */
export async function getOfficeSettings(
  db: Database,
  workspaceId: string,
): Promise<OfficeSettings> {
  if (workspaceId.length === 0) return { ...DEFAULT_OFFICE_SETTINGS };

  const rows = await db
    .select()
    .from(officeSettings)
    .where(eq(officeSettings.workspaceId, workspaceId))
    .limit(1);

  const row = rows[0];
  if (!row) return { ...DEFAULT_OFFICE_SETTINGS };

  return normaliseSettings({
    chatRadiusTiles: row.chatRadiusTiles,
    walkUpRadiusTiles: row.walkUpRadiusTiles,
    replyWindowSeconds: row.replyWindowSeconds,
  });
}

export async function saveOfficeSettings(
  db: Database,
  workspaceId: string,
  input: Partial<OfficeSettings>,
): Promise<OfficeSettings> {
  const current = await getOfficeSettings(db, workspaceId);
  // Clamped here as well as in the form: a settings endpoint is an input like
  // any other, and a chat radius of 10^9 is a denial-of-service on the room.
  const next = normaliseSettings({ ...current, ...input });

  await db
    .insert(officeSettings)
    .values({ workspaceId, ...next })
    .onConflictDoUpdate({
      target: officeSettings.workspaceId,
      set: { ...next, updatedAt: new Date() },
    });

  return next;
}

/**
 * Who is allowed to change instance-wide settings.
 *
 * A recorded fact, not a question asked afresh each time. The first version of
 * this returned "is this the earliest account?", which is not a property of the
 * instance — it is a query whose answer moves when accounts are deleted, and it
 * quietly reassigned who was in charge the first time somebody tidied up a test
 * user.
 *
 * Deliberately not a role and deliberately not a panel. The plan cuts an admin
 * panel; this is the bit underneath one, granted with `pnpm admin`.
 */
export async function isInstanceAdmin(db: Database, userId: string): Promise<boolean> {
  const rows = await db
    .select({ admin: users.instanceAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0]?.admin === true;
}

/** Everyone who may change instance-wide settings. */
export async function listInstanceAdmins(
  db: Database,
): Promise<Array<{ id: string; name: string; pubkey: string }>> {
  return db
    .select({ id: users.id, name: users.name, pubkey: users.pubkey })
    .from(users)
    .where(eq(users.instanceAdmin, true))
    .orderBy(asc(users.createdAt), asc(users.id));
}

export async function setInstanceAdmin(
  db: Database,
  userId: string,
  admin: boolean,
): Promise<void> {
  await db.update(users).set({ instanceAdmin: admin }).where(eq(users.id, userId));
}

/**
 * Is there anybody in charge yet?
 *
 * Used when an account is created: the first one on a fresh instance is the
 * person setting it up, and somebody has to be able to name the place. After
 * that, admin is granted deliberately or not at all.
 */
export async function hasInstanceAdmin(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.instanceAdmin, true))
    .limit(1);

  return rows.length > 0;
}
