import { eq } from 'drizzle-orm';

import {
  DEFAULT_OFFICE_SETTINGS,
  normaliseSettings,
  type OfficeSettings,
} from '../settings.js';
import type { Database } from './client.js';
import { officeSettings } from './schema.js';

/** The single settings row. There is exactly one, and this is its id. */
const GLOBAL = 'global';

export async function getOfficeSettings(db: Database): Promise<OfficeSettings> {
  const rows = await db
    .select()
    .from(officeSettings)
    .where(eq(officeSettings.id, GLOBAL))
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
  input: Partial<OfficeSettings>,
): Promise<OfficeSettings> {
  const current = await getOfficeSettings(db);
  // Clamped here as well as in the form: a settings endpoint is an input like
  // any other, and a chat radius of 10^9 is a denial-of-service on the room.
  const next = normaliseSettings({ ...current, ...input });

  await db
    .insert(officeSettings)
    .values({ id: GLOBAL, ...next })
    .onConflictDoUpdate({ target: officeSettings.id, set: { ...next, updatedAt: new Date() } });

  return next;
}
