'use server';

import {
  displayNameFromPubkey,
  normaliseDisplayName,
  normaliseProfileDescription,
} from '@quintal/shared';
import { getDb, users } from '@quintal/shared/db';
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

  await getDb()
    .update(users)
    .set({ name, description })
    .where(eq(users.id, session.user.id));

  // The office header, the roster and your nameplate all read this.
  revalidatePath('/settings/profile');
  revalidatePath('/office');
  return { ok: true };
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
