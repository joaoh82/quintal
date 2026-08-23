'use client';

import { getHost } from './host';
import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  npubEncode,
  nsecDecode,
  nsecEncode,
  parseAuthPayload,
  signAuthPayload,
} from '@quintal/shared';

/**
 * Key handling in the page.
 *
 * Four ways to hold a key, in descending order of how much we'd like you to
 * use them:
 *
 *   1. The desktop host. The secret sits in the OS keychain and never enters
 *      this page at all — the page asks for a signature, not for a key. Both
 *      durable and unstealable by a bug in the web app, which is why it is
 *      first whenever the app is what's hosting us.
 *   2. A NIP-07 extension (`window.nostr`). Same property, different custodian.
 *   3. In memory, for this tab only. Generated on the spot; closing the tab
 *      forgets it. Safe, and useless for coming back tomorrow.
 *   4. `localStorage`, if you explicitly ask for it. Survives a reload, and is
 *      readable by any script that manages to run on this origin. That is a
 *      real trade and the UI says so in those words.
 *
 * The fourth tier exists for browser users who want to come back tomorrow and
 * have no extension. It is the one the desktop app is meant to retire.
 */

const STORAGE_KEY = 'quintal.nsec';

// --- NIP-07 -----------------------------------------------------------------

interface Nip07 {
  getPublicKey(): Promise<string>;
  signSchnorr?(hexDigest: string): Promise<string>;
  signEvent(event: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

/** Is a signing extension available? Only meaningful in the browser. */
export function hasExtension(): boolean {
  return typeof window !== 'undefined' && typeof window.nostr?.getPublicKey === 'function';
}

// --- stored keys ------------------------------------------------------------

/** The nsec saved to this browser, if the user chose to save one. */
export function loadSavedNsec(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing, or storage disabled. Not an error: it means no key.
    return null;
  }
}

export function saveNsec(nsec: string): void {
  window.localStorage.setItem(STORAGE_KEY, nsec);
}

export function forgetSavedNsec(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** What signing in should do to the key held by this browser. */
export type StorageAction = 'save' | 'forget' | 'leave';

/**
 * Decide the fate of a stored key before signing in.
 *
 * Pure, and separate from the component, because the wrong answer here deletes
 * an identity that cannot be reissued — and the naive version of this rule
 * ("didn't ask to save it, so remove it") does exactly that in two ways that
 * are easy to miss by reading it:
 *
 * - Signing in with an extension is not a statement about the local key at
 *   all. The extension holds a different secret; the stored one is somebody
 *   else's identity sitting in the same browser.
 * - Pasting a *different* nsec with the box unticked says "don't save this
 *   one". It does not say "destroy the one already here".
 *
 * So a key is only forgotten when the user unticks the box for the very key
 * that is stored. Everything else leaves it alone, and the explicit
 * "forget this key" confirmation on the sign-in page stays the only way to
 * deliberately destroy one.
 */
export function storageActionFor({
  identity,
  persist,
  saved,
}: {
  identity: Pick<Identity, 'kind'> & { nsec?: string };
  persist: boolean;
  saved: string | null;
}): StorageAction {
  if (identity.kind !== 'local' || !identity.nsec) return 'leave';
  if (persist) return 'save';
  return saved !== null && saved === identity.nsec ? 'forget' : 'leave';
}

// --- the identity this page is acting as ------------------------------------

/**
 * How the current page can sign.
 *
 * `extension` carries no secret; `local` carries one that lives only as long as
 * this object does, unless the user has explicitly saved it.
 */
export type Identity =
  /** The desktop host signs. The secret is in the OS keychain and never here. */
  | { kind: 'host'; pubkey: string }
  | { kind: 'extension'; pubkey: string }
  | { kind: 'local'; pubkey: string; secretKey: Uint8Array; nsec: string };

export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  return {
    kind: 'local',
    pubkey: getPublicKeyHex(secretKey),
    secretKey,
    nsec: nsecEncode(secretKey),
  };
}

/** A brand-new identity, held in memory. */
export function createIdentity(): Identity {
  return identityFromSecretKey(generateSecretKey());
}

/** An identity from a pasted `nsec1…`. Throws if it isn't one. */
export function identityFromNsec(nsec: string): Identity {
  return identityFromSecretKey(nsecDecode(nsec));
}

/**
 * Adopt the key this computer holds.
 *
 * Preferred over everything else when the app is hosting: the secret lives in
 * the OS keychain rather than in this page, so a bug here cannot leak it and
 * closing the tab cannot lose it. Creates a key on a genuine first run — the
 * host refuses when its keychain is merely locked, rather than starting over.
 */
export async function identityFromHost(): Promise<Identity> {
  const host = getHost();
  if (!host) throw new Error('This is not the Quintal app.');
  return { kind: 'host', pubkey: await host.getPublicKey() };
}

/** Adopt the signing extension's key. */
export async function identityFromExtension(): Promise<Identity> {
  if (!window.nostr) throw new Error('No signing extension found.');
  const pubkey = (await window.nostr.getPublicKey()).trim().toLowerCase();
  return { kind: 'extension', pubkey };
}

/** The npub for an identity, for showing to a human. */
export function npubFor(identity: Identity): string {
  return npubEncode(identity.pubkey);
}

// --- signing ----------------------------------------------------------------

async function sign(identity: Identity, payload: string): Promise<string> {
  if (identity.kind === 'local') {
    return signAuthPayload(identity.secretKey, payload);
  }

  if (identity.kind === 'host') {
    const host = getHost();
    if (!host) throw new Error('The app stopped answering mid-sign-in.');
    return host.signChallenge(payload);
  }

  const nostr = window.nostr;
  if (!nostr) throw new Error('The signing extension went away mid-sign-in.');

  // NIP-07 does not require a raw-Schnorr method, so `signSchnorr` is a bonus
  // when an extension has it. Without it there is no way to get a signature
  // over an arbitrary digest, and we say so rather than silently signing
  // something else the server would reject.
  if (typeof nostr.signSchnorr !== 'function') {
    throw new Error(
      'This signing extension cannot sign a raw challenge. Use a key saved in this browser instead.',
    );
  }

  const { sha256Hex } = await import('./digest');
  return nostr.signSchnorr(sha256Hex(payload));
}

// --- the login round trip ---------------------------------------------------

interface ChallengeResponse {
  nonce: string;
  origin: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });

  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : 'Sign-in failed. Try again.';
    throw new Error(message);
  }
  return data as T;
}

/**
 * Prove we hold this key, and come back with a session cookie set.
 *
 * The origin is taken from the challenge response rather than from
 * `location.origin`: the server decides what a signature is bound to, and a
 * client that picks its own would be binding the signature to whatever an
 * attacker had put in the address bar.
 */
export async function signIn(
  identity: Identity,
  options: { inviteToken?: string } = {},
): Promise<void> {
  const { nonce, origin } = await postJson<ChallengeResponse>(
    '/api/auth/challenge',
    { pubkey: identity.pubkey },
  );

  const payload = buildAuthPayload({
    origin,
    nonce,
    timestamp: Math.floor(Date.now() / 1000),
  });

  // Cheap guard against a malformed origin from a misconfigured deployment
  // producing a payload the server will reject with a confusing message.
  if (!parseAuthPayload(payload)) {
    throw new Error('This deployment issued a challenge we cannot sign.');
  }

  const sig = await sign(identity, payload);

  await postJson('/api/auth/verify', {
    pubkey: identity.pubkey,
    sig,
    payload,
    ...(options.inviteToken ? { inviteToken: options.inviteToken } : {}),
  });
}
