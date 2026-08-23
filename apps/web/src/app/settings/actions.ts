'use server';

import { normaliseSettings, type OfficeSettings } from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  renameWorkspace,
  saveOfficeSettings,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

export interface SettingsState {
  ok: boolean;
  saved?: OfficeSettings;
  error?: string;
}

export async function saveSettingsAction(
  _previous: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  try {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session) return { ok: false, error: 'Not signed in.' };

    // Clamped here as well as in the form: the browser is not the authority on
    // what a sane chat radius is.
    const next = normaliseSettings({
      chatRadiusTiles: Number(formData.get('chatRadiusTiles')),
      walkUpRadiusTiles: Number(formData.get('walkUpRadiusTiles')),
      replyWindowSeconds: Number(formData.get('replyWindowSeconds')),
    });

    const db = getDb();

    // The office is a place, not a person: it starts out named after whoever
    // owns it, and renaming it here is what stops it referring to anybody.
    const name = formData.get('workspaceName');
    if (typeof name === 'string') {
      const workspace = await ensurePersonalWorkspace(db, {
        userId: session.user.id,
        name: session.user.name,
        pubkey: session.user.pubkey,
      });
      const renamed = await renameWorkspace(db, workspace.id, name);
      if (!renamed) return { ok: false, error: 'An office needs a name.' };
    }

    const saved = await saveOfficeSettings(db, next);
    revalidatePath('/settings');
    revalidatePath('/office');
    return { ok: true, saved };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save settings.',
    };
  }
}
