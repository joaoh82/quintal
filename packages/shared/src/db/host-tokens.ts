import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import { AGENT_KEY_BYTES, HOST_TOKEN_PREFIX } from '../agent.js';
import type { Database } from './client.js';
import { agents, hostTokens, users } from './schema.js';

/**
 * Host tokens — a machine's credential, as distinct from an agent's.
 *
 * The whole reason this exists: for the office to define an agent that your
 * laptop then runs, the harness has to authenticate as an agent whose key it
 * was never given. Handing back agent keys would mean storing them
 * recoverably; one revocable per-machine token does not.
 *
 * The trade is real and worth stating plainly: a stolen host token is every
 * agent that owner assigned to that machine, where a stolen agent key is one
 * agent. It is scoped to a single workspace, revocable in one click, and
 * entirely optional — per-agent keys keep working untouched.
 */

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * May this machine act as this agent?
 *
 * Pulled out of the two places that used to ask inline, because it is the one
 * predicate that makes host tokens safe and it deserves to be readable, testable
 * and impossible to get subtly different in two spots.
 *
 * Every clause is load-bearing:
 * - **same workspace** — a token is scoped to the workspace it was made in.
 * - **same owner** — sharing a workspace must not mean a teammate's laptop can
 *   animate your agents. This is the one that stops a colleague's compromised
 *   machine speaking as you.
 * - **not revoked** — revoking an agent must not be undone by a machine that
 *   still remembers it.
 */
export function hostMayActAs(
  host: { workspaceId: string; ownerUserId: string },
  agent: { workspaceId: string; ownerUserId: string; revoked: boolean } | null,
): boolean {
  if (!agent) return false;
  if (agent.revoked) return false;
  if (agent.workspaceId !== host.workspaceId) return false;
  if (agent.ownerUserId !== host.ownerUserId) return false;
  return true;
}

/**
 * Should this machine be running this agent?
 *
 * Assignment on top of authorisation: `hostMayActAs` says the machine *could*,
 * this says the office *asked it to*. Both, always — an agent assigned to a
 * host it may not act as must not boot there.
 */
export function assignedToHost(
  agent: {
    workspaceId: string;
    ownerUserId: string;
    revoked: boolean;
    enabled: boolean;
    hostLabel: string | null;
    runtimeId: string | null;
    repoSpec: string | null;
  },
  host: { workspaceId: string; ownerUserId: string },
  label: string,
): boolean {
  if (!hostMayActAs(host, agent)) return false;
  if (!agent.enabled) return false;
  if (agent.hostLabel !== label) return false;
  // An agent with no runtime or no workspace was never set up to be launched;
  // it is a per-agent-key agent that happens to live in the same workspace.
  return typeof agent.runtimeId === 'string' && typeof agent.repoSpec === 'string';
}

export interface CreatedHostToken {
  id: string;
  label: string;
  /** The one and only time the plaintext exists. Show it, then forget it. */
  token: string;
}

export async function createHostToken(
  db: Database,
  input: { workspaceId: string; ownerUserId: string; label: string },
): Promise<CreatedHostToken> {
  const token = `${HOST_TOKEN_PREFIX}${randomBytes(AGENT_KEY_BYTES).toString('base64url')}`;
  const id = randomBytes(16).toString('hex');
  const label = input.label.trim().slice(0, 64) || 'this machine';

  await db.insert(hostTokens).values({
    id,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    label,
    tokenHash: hashToken(token),
  });

  return { id, label, token };
}

export async function revokeHostToken(db: Database, id: string): Promise<void> {
  await db
    .update(hostTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(hostTokens.id, id), isNull(hostTokens.revokedAt)));
}

export interface HostIdentity {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  ownerName: string;
  label: string;
}

/** Resolve a token. Null for unknown *and* revoked — the caller can't tell. */
export async function findHostByToken(
  db: Database,
  token: unknown,
): Promise<HostIdentity | null> {
  if (typeof token !== 'string' || !token.startsWith(HOST_TOKEN_PREFIX)) return null;

  const hash = hashToken(token);
  const rows = await db
    .select({
      id: hostTokens.id,
      workspaceId: hostTokens.workspaceId,
      ownerUserId: hostTokens.ownerUserId,
      ownerName: users.name,
      label: hostTokens.label,
      tokenHash: hostTokens.tokenHash,
      revokedAt: hostTokens.revokedAt,
    })
    .from(hostTokens)
    .innerJoin(users, eq(users.id, hostTokens.ownerUserId))
    .where(eq(hostTokens.tokenHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt !== null) return null;
  if (!tokensMatch(row.tokenHash, hash)) return null;

  await db.update(hostTokens).set({ lastSeenAt: new Date() }).where(eq(hostTokens.id, row.id));

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    label: row.label,
  };
}

export async function listHostTokens(db: Database, workspaceId: string) {
  return db
    .select({
      id: hostTokens.id,
      label: hostTokens.label,
      createdAt: hostTokens.createdAt,
      lastSeenAt: hostTokens.lastSeenAt,
      revokedAt: hostTokens.revokedAt,
      ownerUserId: hostTokens.ownerUserId,
    })
    .from(hostTokens)
    .where(eq(hostTokens.workspaceId, workspaceId))
    .orderBy(desc(hostTokens.createdAt));
}

/** One agent a host should be running. */
export interface FleetMember {
  agentId: string;
  name: string;
  runtimeId: string;
  /** As written: a repo name, `*`, or an absolute path. Resolved on the host. */
  repoSpec: string;
}

/**
 * What this host should be running.
 *
 * Deliberately a *pull*: the host asks what it owns and decides what to spawn,
 * rather than the office pushing "run this command". Nothing here is a command
 * line — only a runtime id the host looks up in its own catalogue — so a
 * compromised office still cannot execute arbitrary things on somebody's
 * laptop. It also means the desktop app can serve this same interface locally
 * without a network protocol to secure.
 */
export async function fleetForHost(
  db: Database,
  host: HostIdentity,
  hostLabel: string,
): Promise<FleetMember[]> {
  const rows = await db
    .select({
      agentId: agents.id,
      name: agents.name,
      runtimeId: agents.runtimeId,
      repoSpec: agents.repoSpec,
      hostLabel: agents.hostLabel,
      enabled: agents.enabled,
      revokedAt: agents.revokedAt,
      ownerUserId: agents.ownerUserId,
    })
    .from(agents)
    .where(eq(agents.workspaceId, host.workspaceId));

  return rows
    .filter(
      (row): row is typeof row & { runtimeId: string; repoSpec: string } =>
        assignedToHost(
          {
            workspaceId: host.workspaceId,
            ownerUserId: row.ownerUserId,
            revoked: row.revokedAt !== null,
            enabled: row.enabled,
            hostLabel: row.hostLabel,
            runtimeId: row.runtimeId,
            repoSpec: row.repoSpec,
          },
          host,
          hostLabel,
        ),
    )
    .map((row) => ({
      agentId: row.agentId,
      name: row.name,
      runtimeId: row.runtimeId,
      repoSpec: row.repoSpec,
    }));
}
