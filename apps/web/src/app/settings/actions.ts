'use server';

import { normaliseSettings, type OfficeSettings } from '@quintal/shared';
import { getDb, saveOfficeSettings } from '@quintal/shared/db';
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
      voiceRadiusTiles: Number(formData.get('voiceRadiusTiles')),
    });

    const saved = await saveOfficeSettings(getDb(), next);
    revalidatePath('/settings');
    return { ok: true, saved };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save settings.',
    };
  }
}
