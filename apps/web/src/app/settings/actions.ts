'use server';

import { normaliseSettings, type OfficeSettings } from '@quintal/shared';
import {
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
import { currentOffice } from '@/lib/workspace';

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
    //
    // *This* office — the one the page showed — and not the caller's own.
    // The page and the action used to disagree for a guest: the page showed
    // the host's office, the action wrote to the guest's, so a guest pressing
    // Save renamed their own office to the host's name. One resolver for both.
    const here = await currentOffice(db, session);
    if (!here) return { ok: false, error: 'Not in an office.' };
    const workspace = here.workspace;
    const mayChangeOffice = here.role !== 'guest';

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
    if (
      (officeFields.some((field) => formData.get(field) !== null) ||
        formData.get('workspaceName') !== null) &&
      !mayChangeOffice
    ) {
      return { ok: false, error: 'You are visiting this office; its members change how it works.' };
    }

    // An absent field means "leave this alone", and saying so takes real care.
    //
    // `Number(null)` is 0, not NaN, so reading the form directly would turn a
    // submission that merely omitted these into a reset — to the *floor*,
    // earshot 2 and a reply window of 0. Handing NaN to `normaliseSettings`
    // instead is not the fix either: `clamp` falls back to
    // DEFAULT_OFFICE_SETTINGS, so an office that had been tuned would quietly
    // go back to 12/3/90. Neither is what an omitted field should mean.
    //
    // So the current value is the fallback, chosen before normalising. What
    // *is* present still gets clamped, because the browser is not the authority
    // on what a sane chat radius is.
    const current = await getOfficeSettings(db, workspace.id);
    const given = (field: string, fallback: number): number => {
      const raw = formData.get(field);
      return raw === null ? fallback : Number(raw);
    };
    const next = normaliseSettings({
      chatRadiusTiles: given('chatRadiusTiles', current.chatRadiusTiles),
      walkUpRadiusTiles: given('walkUpRadiusTiles', current.walkUpRadiusTiles),
      replyWindowSeconds: given('replyWindowSeconds', current.replyWindowSeconds),
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
