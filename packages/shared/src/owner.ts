/**
 * Naming who runs a shared server before it starts.
 *
 * The alternative to a claim link (see `db/claim.ts`): set `QUINTAL_OWNER` to
 * your `npub1…` and that key is the instance admin from its first sign-in,
 * with no link to open. The shared-server counterpart of the personal office's
 * `QUINTAL_PERSONAL_OWNER` — except that it names who is in charge rather than
 * who may come in, so everybody else can still sign in as a member.
 */
import { parsePubkey } from './identity.js';

export const OWNER_ENV = 'QUINTAL_OWNER';

type Env = Record<string, string | undefined>;

/**
 * The public key (lowercase hex) named as this instance's admin, or null.
 *
 * A malformed value stops the process rather than being treated as unset: a
 * typo in the variable must not quietly reopen the race it exists to close.
 */
export function instanceOwner(env: Env = process.env): string | null {
  const raw = env[OWNER_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const owner = parsePubkey(raw.trim().toLowerCase());
  if (!owner) {
    throw new Error(`${OWNER_ENV} must be an npub1… or a 64-character hex public key, not ${JSON.stringify(raw)}`);
  }
  return owner;
}
