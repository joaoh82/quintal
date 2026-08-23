'use server';

import {
  displayNameFromPubkey,
  normaliseDisplayName,
  normaliseProfileDescription,
  personalWorkspaceName,
  workspaceNameFollows,
} from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  renameWorkspace,
  users,
} from '@quintal/shared/db';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

export type SaveProfileResult = { ok: true } | { ok: false; error: string };

/**
 * Edit your own display name and description.
 *
 * Scoped to the caller's own row by construction — the id comes from the
 * session, never from the form — so there is no "whose profile" question to
 * get wrong.
 */
export async function saveProfileAction(
  formData: FormData,
): Promise<SaveProfileResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { ok: false, error: 'Not signed in.' };

  // A guest is here for one visit, wearing a badge that says so. Letting them
  // pick a name is the one place self-asserted names stop being harmless:
  // there is no admin, no closed org, and a guest link is a URL that gets
  // forwarded, so "Josh" arriving as a stranger is a plausible attack rather
  // than a preference.
  if (session.session.isGuest) {
    return { ok: false, error: 'Guests keep the name they arrived with.' };
  }

  const name = normaliseDisplayName(formData.get('name'));
  if (!name) {
    return { ok: false, error: 'A display name cannot be empty.' };
  }
  const description = normaliseProfileDescription(formData.get('description'));

  const db = getDb();
  await db
    .update(users)
    .set({ name, description })
    .where(eq(users.id, session.user.id));
  await followOfficeName(session.user.id, session.user.name, name);

  // The office header, the roster and your nameplate all read this.
  revalidatePath('/settings/profile');
  revalidatePath('/settings');
  revalidatePath('/office');
  return { ok: true };
}

/**
 * Carry the office along when it is still named after you.
 *
 * A brand-new office is called "<npub…>'s Office" because the npub is the only
 * name anybody has yet, so renaming yourself to Josh and leaving the office as
 * a string of bech32 is just the old name surviving in a second place.
 *
 * Only when it *still matches* the name you had a moment ago, which is an exact
 * test rather than a guess: an office deliberately called "Acme" cannot match,
 * so a chosen name is never quietly overwritten.
 */
async function followOfficeName(
  userId: string,
  previousName: string,
  nextName: string,
): Promise<void> {
  if (previousName.trim() === nextName) return;

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, { userId, name: nextName });
  if (!workspaceNameFollows(workspace.name, previousName)) return;

  await renameWorkspace(db, workspace.id, personalWorkspaceName(nextName));
}

/** Give the field back to the npub the account started with. */
export async function resetDisplayNameAction(): Promise<SaveProfileResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { ok: false, error: 'Not signed in.' };
  if (session.session.isGuest) {
    return { ok: false, error: 'Guests keep the name they arrived with.' };
  }

  await getDb()
    .update(users)
    .set({ name: displayNameFromPubkey(session.user.pubkey) })
    .where(eq(users.id, session.user.id));

  revalidatePath('/settings/profile');
  revalidatePath('/office');
  return { ok: true };
}
