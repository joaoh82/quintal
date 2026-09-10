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

export function hostFilePath(): string {
  return join(configDir(), HOST_FILE);
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

export function readStoredHost(): StoredHost | null {
  const fromEnv = process.env.QUINTAL_HOST_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return {
      token: fromEnv.trim(),
      url: process.env.QUINTAL_URL ?? 'http://localhost:3000',
      source: 'env',
    };
  }

  evictLegacyHostFile();
  const path = hostFilePath();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredHost;
    if (typeof parsed?.token !== 'string' || parsed.token.length === 0) return null;
    let writtenAt: Date | undefined;
    try {
      writtenAt = statSync(path).mtime;
    } catch {
      // The token is what matters; its age is a nicety.
    }
    return { ...parsed, source: 'file', path, writtenAt };
  } catch {
    return null;
  }
}

export function writeStoredHost(host: StoredHost): string {
  const path = hostFilePath();
  mkdirSync(dirname(path), { recursive: true });
  // A fresh login supersedes whatever the old location held.
  const legacy = legacyHostFilePath();
  if (legacy !== path && existsSync(legacy)) unlinkSync(legacy);
  writeFileSync(path, `${JSON.stringify(host, null, 2)}\n`);
  // A credential for the whole fleet has no business being world-readable.
  chmodSync(path, 0o600);
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
function staleTokenMessage(host: StoredHost): string {
  if (host.source === 'env') {
    return 'the office rejected the host token in QUINTAL_HOST_TOKEN. Check it is the one this office issued.';
  }

  const where = host.path ?? 'the stored host file';
  const age =
    host.writtenAt instanceof Date && !Number.isNaN(host.writtenAt.getTime())
      ? ` (written ${host.writtenAt.toISOString().slice(0, 10)})`
      : '';

  return (
    `the office rejected the host token in ${where}${age}. ` +
    'If the office or its database was recreated since then, that token refers to a machine that no longer exists — ' +
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
