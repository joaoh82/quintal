'use server';

import { normaliseSettings, type OfficeSettings } from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  getOfficeSettings,
  isInstanceAdmin,
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

    const db = getDb();

    // Instance-wide settings, and until this they were writable by anybody with
    // a session — a guest who redeemed an invite link included. A chat radius
    // being changed under everyone is a nuisance; the office's public name is
    // what somebody reads before they sign in, so this became a defacement
    // vector the moment there was a name to deface.
    const mayChangeInstance =
      !session.session.isGuest && (await isInstanceAdmin(db, session.user.id));

    // The form hides these from anybody who cannot change them, so a submission
    // carrying them from somebody who cannot is a crafted one. Refused rather
    // than quietly dropped: silently ignoring half a form and reporting success
    // is the failure this whole change is about.
    const instanceFields = [
      'officeName',
      'chatRadiusTiles',
      'walkUpRadiusTiles',
      'replyWindowSeconds',
    ];
    const attemptedInstance = instanceFields.some((field) => formData.get(field) !== null);
    if (attemptedInstance && !mayChangeInstance) {
      return {
        ok: false,
        error: 'Only the account that set this instance up can change these.',
      };
    }

    // Clamped here as well as in the form: the browser is not the authority on
    // what a sane chat radius is.
    const next = normaliseSettings({
      name: String(formData.get('officeName') ?? ''),
      chatRadiusTiles: Number(formData.get('chatRadiusTiles')),
      walkUpRadiusTiles: Number(formData.get('walkUpRadiusTiles')),
      replyWindowSeconds: Number(formData.get('replyWindowSeconds')),
    });

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

    // Your own office keeps its name either way — that one is yours.
    const saved = mayChangeInstance
      ? await saveOfficeSettings(db, next)
      : await getOfficeSettings(db);
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
