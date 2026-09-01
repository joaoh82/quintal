import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { HOST_TOKEN_PREFIX, acpCommandFor, runtimeById } from '@quintal/shared';

import { ALL_REPOS, ConfigError, expandHome, type AgentConfig } from './config.js';
import { hostLabel } from './runtimes.js';

/**
 * The office-defined fleet: this machine asks what it should be running.
 *
 * Pull, not push. The office says *which agent, which runtime, which repo* —
 * never a command line. The command is built here, from this machine's own
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

function hostFilePath(): string {
  return join(homedir(), '.quintal', 'host.json');
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
  writeFileSync(path, `${JSON.stringify(host, null, 2)}\n`);
  // A credential for the whole fleet has no business being world-readable.
  chmodSync(path, 0o600);
  return path;
}

interface FleetResponse {
  host: { label: string; owner: string; workspaceId: string };
  agents: { agentId: string; name: string; runtimeId: string; repoSpec: string }[];
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
  reposDir: string,
  mapId: string,
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

    const rootedAtReposDir = member.repoSpec.trim() === ALL_REPOS;
    const cwd = rootedAtReposDir
      ? reposDir
      : resolve(reposDir, expandHome(member.repoSpec));

    // The office says which repo; it does not get to say "anywhere".
    //
    // `repoSpec` is the one thing here that is not a catalogue id, and both
    // `~` and a leading `/` walk straight out of the repos directory — as does
    // `../../..`. It is the owner's own configuration, so this is not a
    // privilege boundary so much as a blast radius: an agent is rooted where
    // its owner said, and "where its owner said" should stay inside the
    // directory they nominated for exactly this.
    if (!isInside(reposDir, cwd)) {
      skipped.push({
        name: member.name,
        why: `workspace "${member.repoSpec}" is outside ${reposDir}`,
      });
      continue;
    }

    agents.push({
      name: member.name,
      // The token *is* the credential; the agent id says which agent to be.
      key: '',
      hostToken: host.token,
      agentId: member.agentId,
      harness: 'custom',
      command,
      cwd,
      rootedAtReposDir,
      url: host.url,
      mapId,
      workspaceId: fleet.host.workspaceId,
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

/**
 * Is `candidate` the directory `root`, or somewhere beneath it?
 *
 * Compared after `resolve`, so `..` segments are already collapsed — a textual
 * check on the spec would miss `a/../../b`. The separator matters: without it
 * `/repos-elsewhere` counts as inside `/repos`.
 */
function isInside(root: string, candidate: string): boolean {
  const from = resolve(root);
  const to = resolve(candidate);
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep);
}
