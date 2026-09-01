'use server';

import { normaliseSettings, type OfficeSettings } from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  getOfficeSettings,
  isInstanceAdmin,
  renameWorkspace,
  saveInstanceSettings,
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

    // The deployment's name, and until PR #31 it was writable by anybody with a
    // session — a guest who redeemed an invite link included. It is what
    // somebody reads before they sign in, so it was a defacement vector the
    // moment there was a name to deface.
    const mayChangeInstance =
      !session.session.isGuest && (await isInstanceAdmin(db, session.user.id));

    // The office is yours, so its room is yours to tune. This used to sit
    // behind the instance-admin gate with the deployment name, because every
    // office shared one row and one radius; now that a room belongs to one
    // office, how close you stand to be heard is the owner's call.
    const workspace = await ensurePersonalWorkspace(db, {
      userId: session.user.id,
      name: session.user.name,
      pubkey: session.user.pubkey,
    });
    const mayChangeOffice = !session.session.isGuest;

    // The form hides what somebody cannot change, so a submission carrying it
    // anyway is a crafted one. Refused rather than quietly dropped: silently
    // ignoring half a form and reporting success is the failure this whole
    // gate is about.
    if (formData.get('officeName') !== null && !mayChangeInstance) {
      return {
        ok: false,
        error: 'Only the account that set this instance up can change that.',
      };
    }

    const officeFields = ['chatRadiusTiles', 'walkUpRadiusTiles', 'replyWindowSeconds'];
    if (officeFields.some((field) => formData.get(field) !== null) && !mayChangeOffice) {
      return { ok: false, error: 'Guests cannot change how this office works.' };
    }

    // Clamped here as well as in the form: the browser is not the authority on
    // what a sane chat radius is.
    const next = normaliseSettings({
      chatRadiusTiles: Number(formData.get('chatRadiusTiles')),
      walkUpRadiusTiles: Number(formData.get('walkUpRadiusTiles')),
      replyWindowSeconds: Number(formData.get('replyWindowSeconds')),
    });

    // The office is a place, not a person: it starts out named after whoever
    // owns it, and renaming it here is what stops it referring to anybody.
    const name = formData.get('workspaceName');
    if (typeof name === 'string') {
      const renamed = await renameWorkspace(db, workspace.id, name);
      if (!renamed) return { ok: false, error: 'An office needs a name.' };
    }

    if (formData.get('officeName') !== null) {
      await saveInstanceSettings(db, { name: String(formData.get('officeName') ?? '') });
    }

    const saved = mayChangeOffice
      ? await saveOfficeSettings(db, workspace.id, next)
      : await getOfficeSettings(db, workspace.id);
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
