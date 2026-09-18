import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { HOST_TOKEN_PREFIX, acpCommandFor, runtimeById } from '@quintal/shared';

import { ConfigError, configDir, nestRoot, type AgentConfig } from './config.js';
import { hostLabel } from './runtimes.js';

/**
 * The office-defined fleet: this machine asks what it should be running.
 *
 * Pull, not push. The office says *which agent, which runtime* — never a
 * command line, and never a path: every agent here works in this machine's
 * nest. The command is built here, from this machine's own
 * catalogue, so a compromised office still cannot run arbitrary things on
 * somebody's laptop. It is also why the eventual desktop app needs no new
 * protocol: same interface, served locally.
 */

export interface StoredHost {
  token: string;
  url: string;
  /**
   * Where the token came from, so a rejection can name the thing to fix.
   *
   * "Rejected" and "stale" look identical over HTTP — both are a 401 — but they
   * have different fixes, and the file case is the common one: re-create the
   * office (or the database) and every token on disk silently outlives the row
   * it referred to. Pointing at /settings/agents is right for a revoked token
   * and useless for an orphaned one.
   */
  source?: 'env' | 'file';
  /** The file it was read from, when it came from one. */
  path?: string;
  /** When that file was last written. The tell for an orphaned token. */
  writtenAt?: Date;
  /** Overrides the hostname when this machine should answer to another name. */
  label?: string;
  reposDir?: string;
}

const HOST_FILE = 'host.json';
const DEFAULT_OFFICE = 'http://localhost:3000';

export function hostFilePath(): string {
  return join(configDir(), HOST_FILE);
}

/**
 * The key a stored token is filed under: the office URL, trimmed, with no
 * trailing slash. `http://localhost:3001/` and `http://localhost:3001` are
 * one office; a token minted by one of them is refused by the other if we
 * stored them apart.
 */
export function officeKey(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Where `login` used to put the token, before the nest became every agent's
 * working directory: inside it. Resolved through `nestRoot()` rather than
 * spelled out, so `QUINTAL_NEST_DIR` sandboxes it — a test that writes a
 * token must never be able to reach the real one.
 */
function legacyHostFilePath(): string {
  return join(nestRoot(), HOST_FILE);
}

/**
 * Move a token out of the agents' workspace, if one is still there.
 *
 * Runs before every read of the stored host and every time the nest is
 * settled, so a machine that logged in before the workspace existed is fixed
 * the first time anything runs — not the first time somebody notices an agent
 * quoting the token. Returns where the file went, or null when there was
 * nothing to move. Never throws: a move that fails leaves both files where
 * they are and the caller says so.
 */
export function evictLegacyHostFile(
  from: string = legacyHostFilePath(),
  to: string = hostFilePath(),
): string | null {
  if (from === to || !existsSync(from)) return null;
  try {
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) {
      // Something newer already lives at the new path; the old copy is
      // just a leak to close.
      unlinkSync(from);
      return to;
    }
    try {
      renameSync(from, to);
    } catch {
      // Across filesystems `rename` cannot; copy, then remove the original.
      copyFileSync(from, to);
      unlinkSync(from);
    }
    chmodSync(to, 0o600);
    return to;
  } catch {
    return null;
  }
}

/**
 * What `login` actually writes: one entry per office URL.
 *
 * A token minted by office A means nothing to office B. Filing them under
 * one key — the old shape of this file — is how pointing the same machine
 * at a second office presented the first office's credential and failed
 * with an auth error that named the wrong component.
 */
interface PersistedHost {
  token: string;
  label?: string;
  reposDir?: string;
  /** When this slot was last written, as ISO-8601. */
  writtenAt?: string;
}

function isPersistedHost(value: unknown): value is PersistedHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PersistedHost).token === 'string' &&
    (value as PersistedHost).token.length > 0
  );
}

function loadHostFile(): { hosts: Record<string, PersistedHost>; path: string } {
  evictLegacyHostFile();
  const path = hostFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (record.hosts && typeof record.hosts === 'object' && !Array.isArray(record.hosts)) {
        const hosts: Record<string, PersistedHost> = {};
        for (const [url, entry] of Object.entries(record.hosts as Record<string, unknown>)) {
          if (isPersistedHost(entry)) hosts[officeKey(url)] = entry;
        }
        return { hosts, path };
      }
      // Legacy: a single `{ token, url }` for the whole app. That is the
      // file a `login` wrote before offices were plural, and the token in
      // it belongs to the URL it names.
      if (isPersistedHost(record)) {
        const rawUrl = (parsed as { url?: unknown }).url;
        const url = officeKey(
          typeof rawUrl === 'string' && rawUrl.trim().length > 0 ? rawUrl : DEFAULT_OFFICE,
        );
        return {
          hosts: {
            [url]: {
              token: record.token,
              ...(typeof record.label === 'string' ? { label: record.label } : {}),
              ...(typeof record.reposDir === 'string' ? { reposDir: record.reposDir } : {}),
            },
          },
          path,
        };
      }
    }
  } catch {
    // Missing or unreadable: no stored hosts.
  }
  return { hosts: {}, path };
}

function persistHostFile(hosts: Record<string, PersistedHost>, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const legacy = legacyHostFilePath();
  if (legacy !== path && existsSync(legacy)) unlinkSync(legacy);
  writeFileSync(path, `${JSON.stringify({ hosts }, null, 2)}\n`);
  // A credential for the whole fleet has no business being world-readable.
  chmodSync(path, 0o600);
}

function fileWrittenAt(path: string): Date | undefined {
  try {
    return statSync(path).mtime;
  } catch {
    return undefined;
  }
}

function storedFromPersisted(
  url: string,
  entry: PersistedHost,
  path: string,
  fallbackWrittenAt?: Date,
): StoredHost {
  let writtenAt: Date | undefined;
  if (typeof entry.writtenAt === 'string') {
    const parsed = new Date(entry.writtenAt);
    if (!Number.isNaN(parsed.getTime())) writtenAt = parsed;
  }
  return {
    token: entry.token,
    url,
    source: 'file',
    path,
    writtenAt: writtenAt ?? fallbackWrittenAt,
    label: entry.label,
    reposDir: entry.reposDir,
  };
}

/** Office URLs this machine holds a host token for. */
export function listedOfficeUrls(): string[] {
  return Object.keys(loadHostFile().hosts).sort();
}

/**
 * The host token for one office.
 *
 * `url` selects the slot. Without one, `QUINTAL_URL` is used; if that is
 * unset too and exactly one office is stored, that one is returned — the
 * historical `login` / `up` path. Two or more stored offices and no URL
 * is `null`; the caller says so, rather than guessing and presenting the
 * wrong token.
 *
 * `QUINTAL_HOST_TOKEN` still wins, but only for the office in `QUINTAL_URL`.
 * An env token from office A must not be handed to office B just because
 * `up --url B` was typed in a shell that still has A exported.
 */
export function readStoredHost(url?: string | null): StoredHost | null {
  const envToken = process.env.QUINTAL_HOST_TOKEN?.trim();
  const envUrl = officeKey(process.env.QUINTAL_URL ?? DEFAULT_OFFICE);
  const requested =
    url != null && url.trim().length > 0 ? officeKey(url) : officeKey(process.env.QUINTAL_URL ?? '');

  if (envToken) {
    const envApplies = requested.length === 0 || requested === envUrl;
    if (envApplies) {
      return { token: envToken, url: envUrl, source: 'env' };
    }
  }

  const { hosts, path } = loadHostFile();
  const writtenAt = fileWrittenAt(path);

  if (requested.length > 0) {
    const entry = hosts[requested];
    return entry ? storedFromPersisted(requested, entry, path, writtenAt) : null;
  }

  const urls = Object.keys(hosts);
  if (urls.length === 1) {
    const only = urls[0]!;
    return storedFromPersisted(only, hosts[only]!, path, writtenAt);
  }
  return null;
}

export function writeStoredHost(host: StoredHost): string {
  const url = officeKey(host.url);
  if (url.length === 0) {
    throw new ConfigError('a host token needs the office URL it belongs to');
  }
  const { hosts, path } = loadHostFile();
  hosts[url] = {
    token: host.token,
    ...(host.label && host.label.trim().length > 0 ? { label: host.label.trim() } : {}),
    ...(host.reposDir && host.reposDir.trim().length > 0 ? { reposDir: host.reposDir } : {}),
    writtenAt: new Date().toISOString(),
  };
  persistHostFile(hosts, path);
  return path;
}

interface FleetResponse {
  host: { label: string; owner: string; workspaceId: string };
  agents: {
    agentId: string;
    name: string;
    runtimeId: string;
    profile: string;
    modelId?: string | null;
    /** How many conversations it may answer at once, resolved by the office. */
    parallelism?: number;
    /** Its registered public key, or null. The desktop reads it; the harness does not need to. */
    pubkey?: string | null;
  }[];
}

/**
 * What to say when the office turns a token down.
 *
 * A 401 has two very different causes and the same shape on the wire: the token
 * was revoked, or it outlived the office that issued it — the second being what
 * happens to every stored token the moment a development database is recreated.
 * Naming the file and when it was written lets somebody tell the two apart at a
 * glance, which "it may have been revoked" does not.
 */
/**
 * What to say when the office turns a token down. Exported so the desktop
 * host can use the same words — a 401 from `/api/host/fleet` is this
 * situation, whether the caller is `quintal-acp up` or the app.
 */
export function staleTokenMessage(host: StoredHost): string {
  const office = host.url.trim().length > 0 ? ` at ${host.url}` : '';

  if (host.source === 'env') {
    return (
      `the office${office} rejected the host token in QUINTAL_HOST_TOKEN. ` +
      'Check it is the one this office issued — a token from another office means nothing here. ' +
      'If this machine is not registered with this office, register it again.'
    );
  }

  const where = host.path ?? 'the stored host file';
  const age =
    host.writtenAt instanceof Date && !Number.isNaN(host.writtenAt.getTime())
      ? ` (written ${host.writtenAt.toISOString().slice(0, 10)})`
      : '';

  return (
    `the office${office} rejected the host token in ${where}${age}. ` +
    'If you pointed this machine at a different office, or the office or its database was recreated since then, ' +
    'that token refers to a machine that no longer exists — ' +
    'register this machine again and run `login` with the new token. ' +
    'If you revoked it on purpose, create a new one at /settings/agents.'
  );
}

/**
 * Ask the office what this machine should be running.
 *
 * `label` null means "you tell me": the office answers for the name the token
 * was registered under. That is the right default, because the name lives in
 * the UI where somebody typed it — guessing the OS hostname instead produces a
 * machine called `Joaos-MBP-2.home` asking about a fleet assigned to `laptop`,
 * and a confidently empty answer.
 */
export async function fetchFleet(
  host: StoredHost,
  label: string | null,
): Promise<FleetResponse> {
  if (!host.token.startsWith(HOST_TOKEN_PREFIX)) {
    throw new ConfigError(`a host token starts with "${HOST_TOKEN_PREFIX}"`);
  }

  const url = new URL('/api/host/fleet', host.url);
  if (label !== null) url.searchParams.set('host', label);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${host.token}` },
  });

  if (response.status === 401) {
    throw new ConfigError(staleTokenMessage(host));
  }
  if (!response.ok) {
    throw new ConfigError(`the office returned ${response.status} for the fleet list`);
  }

  return (await response.json()) as FleetResponse;
}

/**
 * Turn what the office said into something spawnable.
 *
 * Every failure here is per agent and reported by name, never fatal: one agent
 * naming a runtime this machine doesn't have must not stop the other four from
 * booting. That is the same rule the supervisor follows at runtime, applied one
 * step earlier.
 */
export function toAgentConfigs(
  fleet: FleetResponse,
  host: StoredHost,
  mapId: string,
  /** Each agent's own key, by agent id, when this machine holds one. */
  keys: ReadonlyMap<string, string> = new Map(),
): { agents: AgentConfig[]; skipped: { name: string; why: string }[] } {
  const agents: AgentConfig[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const member of fleet.agents) {
    const spec = runtimeById(member.runtimeId);
    if (!spec) {
      skipped.push({ name: member.name, why: `unknown runtime "${member.runtimeId}"` });
      continue;
    }

    const command = acpCommandFor(spec);
    if (!command) {
      skipped.push({
        name: member.name,
        why: `${spec.label} has no ACP mode — nothing can drive it`,
      });
      continue;
    }

    // Every office-defined agent works in the nest — see `nest.ts`. The
    // office has no say in the path: it names the agent and the runtime, and
    // this machine decides that both live in the one workspace it keeps, with
    // the owner's repositories reachable under `REPOS/`.
    agents.push({
      name: member.name,
      // Its own key when this machine holds one (credentials v2); otherwise
      // the token is the credential and the agent id says which agent to be.
      key: keys.get(member.agentId) ?? '',
      hostToken: host.token,
      agentId: member.agentId,
      harness: 'custom',
      runtimeId: member.runtimeId,
      command,
      cwd: nestRoot(),
      url: host.url,
      mapId,
      workspaceId: fleet.host.workspaceId,
      profile: member.profile ?? '',
      // Carried as data. It is applied over ACP after the session opens —
      // it is deliberately not on `command`, which is built from the
      // catalogue alone.
      ...(typeof member.modelId === 'string' && member.modelId.length > 0
        ? { modelId: member.modelId }
        : {}),
      // Resolved by the office, so a change to either the agent's own number
      // or the office default shows up here — and restarts the agent, which
      // is how a pool changes size.
      ...(typeof member.parallelism === 'number' && Number.isFinite(member.parallelism)
        ? { parallelism: member.parallelism }
        : {}),
    });
  }

  return { agents, skipped };
}

/**
 * The name this machine answers to, or null to let the office decide.
 *
 * Only an explicit `--host` or a stored label overrides it. `hostname()` is
 * deliberately *not* a fallback here — see `fetchFleet`.
 */
export function labelFor(host: StoredHost): string | null {
  const stored = (host.label ?? '').trim();
  return stored.length > 0 ? stored : null;
}

/** This machine's OS name, for the host report only. */
export { hostLabel };
