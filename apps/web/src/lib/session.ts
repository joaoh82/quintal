import { getDb } from '@quintal/shared/db';
import { headers } from 'next/headers';
import { cache } from 'react';

import { auth } from '@/lib/auth';
import { currentOffice, type CurrentOffice } from '@/lib/workspace';

/**
 * The session and the office for this request, once.
 *
 * A settings page is rendered as a layout plus a page, and both need to
 * know who is asking and where they are. Each used to look both up on its
 * own — two session reads and two office resolutions per click. `cache`
 * dedupes within one render, so the second caller gets the first answer.
 */
export const requestSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export const requestOffice = cache(async (): Promise<CurrentOffice | null> => {
  const session = await requestSession();
  if (!session) return null;
  return currentOffice(getDb(), session);
});
