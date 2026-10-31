'use server';

import { personalMode } from '@quintal/shared';
import { getDb, redeemClaimToken } from '@quintal/shared/db';
import { redirect } from 'next/navigation';

import { requestSession } from '@/lib/session';

/**
 * Claim the instance as the person already signed in.
 *
 * Either way it ends on a page: the settings they came to fill in, or back at
 * the claim page, which looks the link up again and says why it no longer
 * works. The refusal is not carried in the URL — the page can work it out, and
 * a reason that could be typed into an address bar is one that could be faked.
 */
export async function claimAsSignedIn(token: string): Promise<void> {
  const session = await requestSession();
  if (!session || session.session.isGuest || personalMode()) {
    redirect(`/claim?t=${encodeURIComponent(token)}`);
  }
  const claimed = await redeemClaimToken(getDb(), token, session.user.id);
  redirect(claimed.ok ? '/settings' : `/claim?t=${encodeURIComponent(token)}`);
}
