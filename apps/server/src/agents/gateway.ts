import { logger } from '@colyseus/core';
import {
  AGENT_CHAT_INTERVAL_MS,
  AGENT_MOVE_INTERVAL_MS,
  type AgentEventKind,
  type AgentScope,
} from '@quintal/shared';
import {
  findAgentByKey,
  findAgentIdentityById,
  findHostByToken,
  findRevokedAgentIds,
  getDb,
  recordAgentEvent,
  recordHost,
  setAgentStatus,
  setAgentWorkspace,
  touchAgent,
  type AgentIdentity,
} from '@quintal/shared/db';

/**
 * The bits of the agent gateway that talk to the database, kept out of the room
 * so `OfficeRoom` stays about the room.
 */

export interface AgentSession {
  identity: AgentIdentity;
  /** Last time each rate-limited verb was allowed through. */
  lastChatAt: number;
  lastMoveAt: number;
}

export async function authenticateAgent(key: unknown): Promise<AgentIdentity | null> {
  return findAgentByKey(getDb(), key);
}

/**
 * A host token acting as one of its owner's agents.
 *
 * The second credential in the protocol, and the narrower-looking one is the
 * more powerful: an agent key is one agent, a host token is every agent its
 * owner assigned to that machine. Which is exactly why the agent id is checked
 * against ownership here rather than trusted from the wire — a host token must
 * never be able to animate somebody else's agent, even inside a shared
 * workspace.
 */
export async function authenticateHostAgent(
  token: unknown,
  agentId: unknown,
): Promise<AgentIdentity | null> {
  if (typeof agentId !== 'string' || agentId.length === 0) return null;

  const db = getDb();
  const host = await findHostByToken(db, token);
  if (!host) return null;

  const agent = await findAgentIdentityById(db, agentId);
  if (!agent) return null;
  if (agent.workspaceId !== host.workspaceId) return null;
  if (agent.ownerUserId !== host.ownerUserId) return null;

  return agent;
}

export function hasScope(identity: AgentIdentity, scope: AgentScope): boolean {
  return identity.scopes.includes(scope);
}

/**
 * Rate limits, per verb, per agent.
 *
 * Deliberately stricter than the human limits: a human who spams is a person
 * being annoying, and a room can handle that socially. An agent that spams is a
 * loop, and it will not stop on its own.
 */
export function allowChat(session: AgentSession, now: number): number {
  const wait = session.lastChatAt + AGENT_CHAT_INTERVAL_MS - now;
  if (wait > 0) return wait;
  session.lastChatAt = now;
  return 0;
}

export function allowMove(session: AgentSession, now: number): number {
  const wait = session.lastMoveAt + AGENT_MOVE_INTERVAL_MS - now;
  if (wait > 0) return wait;
  session.lastMoveAt = now;
  return 0;
}

/**
 * Write to the audit log.
 *
 * Fire-and-forget on purpose: an agent's command must not wait on a disk write,
 * and a failed audit insert must not swallow the command. It is logged loudly
 * instead — a silently missing audit trail would be worse than either.
 */
export function audit(
  agentId: string,
  kind: AgentEventKind,
  payload?: unknown,
): void {
  void recordAgentEvent(getDb(), agentId, kind, payload).catch((error: unknown) => {
    logger.error(`[agent] audit write failed (${kind}) for ${agentId}`, error);
  });
}

export function markSeen(agentId: string): void {
  void touchAgent(getDb(), agentId).catch(() => {
    // Best-effort presence bookkeeping; not worth a log line per command.
  });
}

export function persistStatus(agentId: string, status: string): void {
  void setAgentStatus(getDb(), agentId, status).catch((error: unknown) => {
    logger.error(`[agent] status write failed for ${agentId}`, error);
  });
}

/**
 * Record what a machine can run, and where one agent is rooted.
 *
 * Fire-and-forget for the same reason as the audit write: this is bookkeeping
 * about somebody's laptop, and no agent command should wait on it.
 */
export function persistHostReport(input: {
  agentId: string;
  workspaceId: string;
  ownerUserId: string;
  report: unknown;
  workspacePath: string;
  rootedAtReposDir: boolean;
}): void {
  const db = getDb();
  void recordHost(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    report: input.report,
  }).catch((error: unknown) => {
    logger.error(`[agent] host report failed for ${input.agentId}`, error);
  });
  void setAgentWorkspace(
    db,
    input.agentId,
    input.workspacePath,
    input.rootedAtReposDir,
  ).catch((error: unknown) => {
    logger.error(`[agent] workspace write failed for ${input.agentId}`, error);
  });
}

/**
 * Which of these agents have had their keys revoked.
 *
 * Revocation happens in the web app; in development that's a separate process,
 * so there is no in-memory signal to listen for. The room polls this and kicks
 * anyone who comes back revoked.
 */
export async function findRevoked(agentIds: readonly string[]): Promise<Set<string>> {
  try {
    return await findRevokedAgentIds(getDb(), agentIds);
  } catch (error: unknown) {
    logger.error('[agent] revocation check failed', error);
    // Fail open: a database hiccup should not eject every working agent.
    return new Set();
  }
}
