'use server';

import {
  INVITE_MAX_USES_LIMIT,
  createInviteLink,
  ensurePersonalWorkspace,
  getDb,
  revokeInviteLink,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Minting and revoking guest links.
 *
 * Same rule as agent keys and host tokens: the plaintext exists exactly once,
 * in the response of the action that created it. The row keeps only a hash, so
 * this page can list a link and revoke it but can never show it again.
 */

async function workspaceForCaller() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });
  return { db, workspace, userId: session.user.id };
}

export type CreateGuestLinkResult =
  | { ok: true; url: string; expiresAt: number; maxUses: number }
  | { ok: false; error: string };

export async function createGuestLinkAction(
  formData: FormData,
): Promise<CreateGuestLinkResult> {
  try {
    const { db, workspace, userId } = await workspaceForCaller();

    const hours = Number(formData.get('hours') ?? 72);
    const maxUses = Number(formData.get('maxUses') ?? 1);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, error: 'Pick a positive number of hours.' };
    }
    if (!Number.isFinite(maxUses) || maxUses < 1) {
      return { ok: false, error: 'A link has to allow at least one guest.' };
    }

    const { link, token } = await createInviteLink(db, {
      workspaceId: workspace.id,
      createdByUserId: userId,
      ttlMs: Math.min(hours, 24 * 30) * 3_600_000,
      maxUses: Math.min(maxUses, INVITE_MAX_USES_LIMIT),
    });

    // Built from the configured origin rather than the request host: this is a
    // URL somebody will paste elsewhere, and it has to point at the deployment
    // rather than at whatever hostname the browser happened to use.
    const origin = new URL(
      process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    ).origin;

    revalidatePath('/settings/guests');
    return {
      ok: true,
      url: `${origin}/join/${token}`,
      expiresAt: link.expiresAt.getTime(),
      maxUses: link.maxUses,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'Could not create the link.',
    };
  }
}

export async function revokeGuestLinkAction(formData: FormData): Promise<void> {
  const { db, workspace } = await workspaceForCaller();
  const id = String(formData.get('linkId') ?? '');
  // Scoped to the caller's workspace, so an id from somewhere else does nothing.
  await revokeInviteLink(db, id, workspace.id);
  revalidatePath('/settings/guests');
}
