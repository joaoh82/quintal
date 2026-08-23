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

/** How a runtime binary was found, so the UI can explain what it is showing. */
export interface HostRuntime {
  /** Matches `RuntimeSpec.id` in the shared catalogue. */
  id: string;
  installed: boolean;
  /** Absolute path the binary resolved to, when it did. */
  path: string | null;
}

export interface HostStatus {
  /** Hostname, matching what the harness reports as `agent_hosts.label`. */
  label: string;
  /** Where this machine keeps repositories. */
  reposDir: string;
  /** Agents this host currently has running. */
  running: string[];
  version: string;
}

export interface AgentSpec {
  /** The agent's name in the office, used to stop it again. */
  name: string;
  /** Runtime id from the shared catalogue — never a free-form command. */
  runtimeId: string;
  /** Repo the agent is rooted at, as written by the person. */
  repoSpec: string;
  /** The agent's credential. Passed to the child through the environment. */
  agentKey: string;
}

/**
 * What the identity subsystem can tell the UI about itself.
 *
 * `locked` is the state that must never be silently skipped: it means a key
 * exists but the keychain would not hand it over. Treating that as "no key" and
 * generating a fresh one would replace somebody's identity — and their office —
 * with a new one, which is unrecoverable.
 */
export type IdentityState = 'none' | 'ready' | 'locked';

export interface HostBridge {
  // --- identity -----------------------------------------------------------
  hasIdentity(): Promise<IdentityState>;
  /** x-only public key, lowercase hex. */
  getPublicKey(): Promise<string>;
  /** BIP-340 signature over sha256(payload), lowercase hex. */
  signChallenge(payload: string): Promise<string>;
  /** NIP-49 `ncryptsec…`. The passphrase is generated when not supplied. */
  exportBackup(passphrase?: string): Promise<{ blob: string; passphrase: string }>;
  importIdentity(secret: string, passphrase?: string): Promise<string>;

  // --- the machine --------------------------------------------------------
  detectRuntimes(): Promise<HostRuntime[]>;
  listRepos(): Promise<string[]>;
  pickReposDir(): Promise<string | null>;
  hostStatus(): Promise<HostStatus>;
  startAgent(spec: AgentSpec): Promise<void>;
  stopAgent(name: string): Promise<void>;
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
    exportBackup: (passphrase) =>
      call<{ blob: string; passphrase: string }>('export_backup', { passphrase }),
    importIdentity: (secret, passphrase) =>
      call<string>('import_identity', { secret, passphrase }),
    detectRuntimes: () => call<HostRuntime[]>('detect_runtimes'),
    listRepos: () => call<string[]>('list_repos'),
    pickReposDir: () => call<string | null>('pick_repos_dir'),
    hostStatus: () => call<HostStatus>('host_status'),
    startAgent: (spec) => call<void>('start_agent', { spec }),
    stopAgent: (name) => call<void>('stop_agent', { name }),
  };
}
