import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(hostFilePath(), 'utf8')) as StoredHost;
    return typeof parsed?.token === 'string' && parsed.token.length > 0 ? parsed : null;
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
  host: { label: string; owner: string };
  agents: { agentId: string; name: string; runtimeId: string; repoSpec: string }[];
}

/** Ask the office what this machine should be running. */
export async function fetchFleet(
  host: StoredHost,
  label: string,
): Promise<FleetResponse> {
  if (!host.token.startsWith(HOST_TOKEN_PREFIX)) {
    throw new ConfigError(`a host token starts with "${HOST_TOKEN_PREFIX}"`);
  }

  const url = new URL('/api/host/fleet', host.url);
  url.searchParams.set('host', label);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${host.token}` },
  });

  if (response.status === 401) {
    throw new ConfigError(
      'the office rejected this host token — it may have been revoked. Create a new one at /settings/agents.',
    );
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
    });
  }

  return { agents, skipped };
}

export function labelFor(host: StoredHost): string {
  return (host.label ?? '').trim() || hostLabel();
}
