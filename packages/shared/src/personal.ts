/**
 * Personal mode: one office, one owner, no door.
 *
 * The desktop app can run a private copy of this server for one person, on
 * loopback, with nothing else on the machine meant to reach it. Loopback is
 * not an access control, though: every process on the computer can open a
 * socket to 127.0.0.1, and on a fresh database the first key to sign in
 * becomes the instance admin. A personal office would otherwise be claimable
 * by whichever local process asked first.
 *
 * So the app names the owner up front. With `QUINTAL_PERSONAL_OWNER` set to a
 * public key, sign-in is accepted for that key and refused for every other,
 * and guest links cannot be minted or redeemed — a personal office has no
 * guests, by definition rather than by omission. Unset, nothing here applies
 * and the server behaves as a shared deployment.
 *
 * Read through a function, like the dev ports are, so the value is whatever
 * the environment says now and a test can hand in its own.
 */
import { isPubkeyHex } from './identity.js';

export const PERSONAL_OWNER_ENV = 'QUINTAL_PERSONAL_OWNER';

export interface PersonalMode {
  /** The one x-only public key, lowercase hex, allowed to hold an account. */
  owner: string;
}

type Env = Record<string, string | undefined>;

/**
 * Whether this server is somebody's personal office, and whose.
 *
 * A malformed key is refused loudly rather than treated as unset: a typo in
 * the variable must not quietly turn a private office into a shared one.
 */
export function personalMode(env: Env = process.env): PersonalMode | null {
  const raw = env[PERSONAL_OWNER_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const owner = raw.trim().toLowerCase();
  if (!isPubkeyHex(owner)) {
    throw new Error(
      `${PERSONAL_OWNER_ENV} must be a 32-byte x-only public key in hex, not ${JSON.stringify(raw)}`,
    );
  }
  return { owner };
}

/** Why a sign-in was refused by a personal office, in words for the person. */
export const PERSONAL_REFUSALS = {
  notOwner: 'This is a personal office. Only its owner can sign in here.',
  noGuests: 'This is a personal office. It has no guest links.',
} as const;
