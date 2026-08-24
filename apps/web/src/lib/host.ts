/**
 * The desktop bridge.
 *
 * One narrow interface between the web UI and whatever is hosting it. There is
 * exactly one UI — this app — and the desktop host is a *host*, not a second
 * client: it adds capabilities a browser cannot have (a key in the OS keychain,
 * spawning a process, a global hotkey) and nothing else. A screen that exists
 * only in the app is a bug, not a feature.
 *
 * Everything here degrades. A browser gets `null` from `getHost()` and the UI
 * shows an honest "this needs the app" state rather than a broken control.
 *
 * Detection is by feature, never by user agent. A user-agent string is a claim
 * anybody can make; `window.__TAURI_INTERNALS__` either exists and answers, or
 * it does not.
 */

/**
 * What the identity subsystem can tell the UI about itself.
 *
 * `locked` is the state that must never be silently skipped: it means a key
 * exists but the keychain would not hand it over. Treating that as "no key" and
 * generating a fresh one would replace somebody's identity — and their office —
 * with a new one, which is unrecoverable.
 */
export type IdentityState = 'none' | 'ready' | 'locked';

/** An error the UI can branch on rather than only display. */
export interface HostError {
  code:
    | 'locked'
    | 'bad_key'
    | 'no_backup'
    | 'wrong_identity'
    | 'bad_passphrase'
    | 'not_a_backup'
    | 'cost_too_high'
    | 'host_error';
  message: string;
}

export interface Backup {
  /** `ncryptsec1…` — the secret key, encrypted under the passphrase. */
  blob: string;
  passphrase: string;
  /** Hand back to `confirmBackup`. Proves an export actually happened. */
  token: string;
}

export function isHostError(value: unknown): value is HostError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as HostError).code === 'string' &&
    typeof (value as HostError).message === 'string'
  );
}

/**
 * The bridge.
 *
 * Identity only, for now. Runtime detection, repo listing and agent spawning
 * land with the slices that implement them — a method declared here that the
 * host does not answer is worse than an absent one, because the UI cannot tell
 * the difference until it calls.
 *
 * Most of this hands nothing secret across: the page asks for a public key, or
 * for a signature over a payload it supplies, so a bug in the page cannot leak
 * an identity the page never held.
 *
 * `exportBackup` is the exception, and it is deliberate. A backup has to be
 * readable by a person to be written down, so it crosses the bridge — which
 * means script running on the office origin could exfiltrate the identity
 * rather than only borrow it. That is the cost of the paper backup existing at
 * all; the mitigations are that only the configured origin can call it, and
 * that it is the one call whose result the UI shows rather than stores.
 */
export interface HostBridge {
  hasIdentity(): Promise<IdentityState>;
  /** x-only public key, lowercase hex. Creates one on a genuine first run. */
  getPublicKey(): Promise<string>;
  /** BIP-340 signature over sha256(payload), lowercase hex. */
  signChallenge(payload: string): Promise<string>;
  /**
   * Replace the stored identity. Returns the new npub.
   *
   * Takes an `nsec`, bare hex, or an `ncryptsec1…` with its passphrase.
   */
  importIdentity(secret: string, passphrase?: string): Promise<string>;

  /**
   * Encrypt the identity for safekeeping. Generates a passphrase unless given
   * one. Does *not* mark the backup as stored — see `confirmBackup`.
   */
  exportBackup(passphrase?: string): Promise<Backup>;
  /** Record that the person has actually written the backup down. */
  confirmBackup(token: string): Promise<void>;
  /** Whether a backup has been confirmed, which is what unlocks the wipe. */
  canWipe(): Promise<boolean>;
  /** Forget the identity on this machine. Refused until a backup is confirmed. */
  wipeIdentity(): Promise<void>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Is this page running inside the desktop host? */
export function hasHost(): boolean {
  return (
    typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined
  );
}

let cached: HostBridge | null | undefined;

/**
 * The bridge, or null in a browser.
 *
 * Cached because the answer cannot change within a page load — the host is
 * either there when the page boots or it never will be.
 */
export function getHost(): HostBridge | null {
  if (cached !== undefined) return cached;
  cached = hasHost() ? tauriBridge() : null;
  return cached;
}

/** Reset the cache. Tests only — a real page never changes host mid-life. */
export function resetHostForTests(next?: HostBridge | null): void {
  cached = next;
}

/**
 * The Tauri implementation.
 *
 * `invoke` is imported lazily so a browser bundle never pulls the Tauri API in
 * at all: the import only runs once the bridge has already been detected.
 */
function tauriBridge(): HostBridge {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  };

  return {
    hasIdentity: () => call<IdentityState>('has_identity'),
    getPublicKey: () => call<string>('get_public_key'),
    signChallenge: (payload) => call<string>('sign_challenge', { payload }),
    importIdentity: (secret, passphrase) =>
      call<string>('import_identity', { secret, passphrase }),
    exportBackup: (passphrase) => call<Backup>('export_backup', { passphrase }),
    confirmBackup: (token) => call<void>('confirm_backup', { token }),
    canWipe: () => call<boolean>('can_wipe'),
    wipeIdentity: () => call<void>('wipe_identity'),
  };
}
