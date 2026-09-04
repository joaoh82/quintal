import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import {
  AGENT_KEY_BYTES,
  AGENT_KEY_PREFIX,
  AGENT_STATUS_MAX_LENGTH,
  DEFAULT_AGENT_SCOPES,
  isValidMemorySlug,
  memoryLimitFor,
  normaliseAgentDescription,
  normaliseAgentInstructions,
  normaliseAgentName,
  parseScopes,
  type AgentEventKind,
  type AgentScope,
} from '../agent.js';
import { displayName } from '../identity.js';
import type { Database } from './client.js';
import { agentEvents, agentMemory, agents, memberships, users } from './schema.js';

/**
 * Everything that touches the agent tables. Kept in `shared` because both the
 * Next.js app (settings pages) and the game server (the gateway) need it, and
 * two copies of "is this key valid" is one copy too many.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

// --- keys ------------------------------------------------------------------

/** Hash a key for storage or comparison. Keys are high-entropy, so plain SHA-256
 * is right here — a password KDF would only slow down the hot join path. */
export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateAgentKey(): string {
  return `${AGENT_KEY_PREFIX}${randomBytes(AGENT_KEY_BYTES).toString('base64url')}`;
}

/** Constant-time compare of two hex digests. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

// --- creation and revocation ----------------------------------------------

export interface CreateAgentInput {
  workspaceId: string;
  ownerUserId: string;
  name: string;
  spriteKey: string;
  /** One line about what it does, shown on its card. */
  description?: string;
  /** How it should behave, prepended to its system prompt. */
  instructions?: string;
  scopes?: readonly AgentScope[];
  /**
   * How a host should launch this agent, when the office defines it.
   *
   * All three together or none: an agent with a runtime but no host has nowhere
   * to run, and one with a host but no runtime has nothing to run.
   */
  launch?: { runtimeId: string; repoSpec: string; hostLabel: string; modelId?: string | null };
}

export interface CreatedAgent {
  id: string;
  name: string;
  /** The one and only time the plaintext key exists. Show it, then forget it. */
  key: string;
}

export async function createAgent(
  db: Database,
  input: CreateAgentInput,
): Promise<CreatedAgent> {
  const key = generateAgentKey();
  const id = newId();

  await db.insert(agents).values({
    id,
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    name: normaliseAgentName(input.name),
    spriteKey: input.spriteKey,
    description: normaliseAgentDescription(input.description),
    instructions: normaliseAgentInstructions(input.instructions),
    apiKeyHash: hashAgentKey(key),
    scopes: [...(input.scopes ?? DEFAULT_AGENT_SCOPES)],
    ...(input.launch
      ? {
          runtimeId: input.launch.runtimeId,
          repoSpec: input.launch.repoSpec,
          hostLabel: input.launch.hostLabel,
          modelId: input.launch.modelId ?? null,
        }
      : {}),
  });

  // The first line of the log, so the audit trail starts where the agent does.
  await recordAgentEvent(db, id, 'agent.created', {
    name: normaliseAgentName(input.name),
    ownerUserId: input.ownerUserId,
    scopes: [...(input.scopes ?? DEFAULT_AGENT_SCOPES)],
  });

  return { id, name: normaliseAgentName(input.name), key };
}

/**
 * Change what an agent's owner says it is and how it should behave.
 *
 * Normalised here as well as in the form, for the same reason every other
 * write is: a server action is an input like any other, and instructions go
 * straight into a prompt paid for on every priming turn.
 *
 * Recorded as an event, because changing what an agent was told to be is a
 * thing somebody may need to explain later — the log already carries who
 * created and revoked it.
 */
export async function setAgentProfile(
  db: Database,
  agentId: string,
  input: { description?: string; instructions?: string },
): Promise<{ description: string; instructions: string }> {
  const rows = await db
    .select({ description: agents.description, instructions: agents.instructions })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const current = rows[0];
  if (!current) throw new Error('No such agent.');

  // An absent field means "leave it alone", not "clear it".
  const next = {
    description:
      input.description === undefined
        ? current.description
        : normaliseAgentDescription(input.description),
    instructions:
      input.instructions === undefined
        ? current.instructions
        : normaliseAgentInstructions(input.instructions),
  };

  await db.update(agents).set(next).where(eq(agents.id, agentId));
  await recordAgentEvent(db, agentId, 'agent.profile_changed', {
    descriptionBytes: Buffer.byteLength(next.description, 'utf8'),
    instructionsBytes: Buffer.byteLength(next.instructions, 'utf8'),
  });

  return next;
}

export async function revokeAgent(
  db: Database,
  agentId: string,
  revokedByUserId: string,
): Promise<void> {
  await db
    .update(agents)
    .set({ revokedAt: new Date(), status: '' })
    .where(and(eq(agents.id, agentId), isNull(agents.revokedAt)));

  await recordAgentEvent(db, agentId, 'agent.revoked', { revokedByUserId });
}

// --- lookup ----------------------------------------------------------------

export interface AgentIdentity {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  ownerName: string;
  name: string;
  /** One line about what it does, for people. */
  description: string;
  /** How its owner told it to behave, for the model. */
  instructions: string;
  spriteKey: string;
  scopes: AgentScope[];
  status: string;
}

/**
 * Resolve an API key to an agent. Returns null for unknown *and* revoked keys —
 * the caller should not be able to tell the difference.
 */
export async function findAgentByKey(
  db: Database,
  key: unknown,
): Promise<AgentIdentity | null> {
  if (typeof key !== 'string' || !key.startsWith(AGENT_KEY_PREFIX)) return null;

  const hash = hashAgentKey(key);
  const rows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
      // Joined so a blank name can fall back to the owner's npub; stripped
      // from the result below, because the shape is about the agent.
      ownerPubkey: users.pubkey,
      name: agents.name,
      description: agents.description,
      instructions: agents.instructions,
      spriteKey: agents.spriteKey,
      scopes: agents.scopes,
      status: agents.status,
      apiKeyHash: agents.apiKeyHash,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(eq(agents.apiKeyHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt !== null) return null;
  // The lookup was by hash, so this can only fail on a hash collision; check it
  // anyway, in constant time, because the cost is nothing.
  if (!hashesMatch(row.apiKeyHash, hash)) return null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName: displayName({ name: row.ownerName, pubkey: row.ownerPubkey }),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    spriteKey: row.spriteKey,
    scopes: parseScopes(row.scopes),
    status: row.status,
  };
}

/**
 * The same identity `findAgentByKey` returns, but resolved by id.
 *
 * Used only by host-token auth, which has already proved *which machine* is
 * calling and now needs the agent it claims to be. Revoked agents come back
 * null here too — a host token must not resurrect one.
 */
export async function findAgentIdentityById(
  db: Database,
  agentId: string,
): Promise<AgentIdentity | null> {
  const rows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
      // Joined so a blank name can fall back to the owner's npub; stripped
      // from the result below, because the shape is about the agent.
      ownerPubkey: users.pubkey,
      name: agents.name,
      description: agents.description,
      instructions: agents.instructions,
      spriteKey: agents.spriteKey,
      scopes: agents.scopes,
      status: agents.status,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(eq(agents.id, agentId))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt !== null) return null;

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName: displayName({ name: row.ownerName, pubkey: row.ownerPubkey }),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    spriteKey: row.spriteKey,
    scopes: parseScopes(row.scopes),
    status: row.status,
  };
}

/** Which of these agent ids have been revoked. Used to kick live sessions. */
export async function findRevokedAgentIds(
  db: Database,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .select({ id: agents.id, revokedAt: agents.revokedAt })
    .from(agents)
    .where(sql`${agents.id} in ${ids}`);

  const revoked = new Set<string>();
  for (const row of rows) if (row.revokedAt !== null) revoked.add(row.id);
  // An id that has vanished entirely (workspace deleted) counts as revoked too.
  const known = new Set(rows.map((row) => row.id));
  for (const id of ids) if (!known.has(id)) revoked.add(id);
  return revoked;
}

export interface AgentListEntry {
  id: string;
  workspaceId: string;
  name: string;
  /** One line its owner wrote about what it does. */
  description: string;
  /** How its owner told it to behave. Editable from the agents list. */
  instructions: string;
  spriteKey: string;
  scopes: AgentScope[];
  status: string;
  ownerUserId: string;
  ownerName: string;
  /** How a host should launch it, when the office defines that. Null otherwise. */
  runtimeId: string | null;
  repoSpec: string | null;
  hostLabel: string | null;
  /** The model its owner chose, by the runtime's own id. Null for the runtime's default. */
  modelId: string | null;
  /** Whether a host pulling its fleet should be running this. */
  enabled: boolean;
  /** Where its harness said it is rooted. Empty until one connects. */
  workspacePath: string;
  rootedAtReposDir: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export async function listAgentsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<AgentListEntry[]> {
  const rows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      name: agents.name,
      description: agents.description,
      instructions: agents.instructions,
      spriteKey: agents.spriteKey,
      scopes: agents.scopes,
      status: agents.status,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
      // Joined so a blank name can fall back to the owner's npub; stripped
      // from the result below, because the shape is about the agent.
      ownerPubkey: users.pubkey,
      runtimeId: agents.runtimeId,
      repoSpec: agents.repoSpec,
      hostLabel: agents.hostLabel,
      modelId: agents.modelId,
      enabled: agents.enabled,
      workspacePath: agents.workspacePath,
      rootedAtReposDir: agents.rootedAtReposDir,
      createdAt: agents.createdAt,
      lastSeenAt: agents.lastSeenAt,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(desc(agents.createdAt));

  return rows.map(({ ownerPubkey, ...row }) => ({
    ...row,
    ownerName: displayName({ name: row.ownerName, pubkey: ownerPubkey }),
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt?.getTime() ?? null,
    revokedAt: row.revokedAt?.getTime() ?? null,
  }));
}

export async function findAgentById(
  db: Database,
  agentId: string,
): Promise<AgentListEntry | null> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      instructions: agents.instructions,
      spriteKey: agents.spriteKey,
      scopes: agents.scopes,
      status: agents.status,
      ownerUserId: agents.ownerUserId,
      ownerName: users.name,
      // Joined so a blank name can fall back to the owner's npub; stripped
      // from the result below, because the shape is about the agent.
      ownerPubkey: users.pubkey,
      workspaceId: agents.workspaceId,
      runtimeId: agents.runtimeId,
      repoSpec: agents.repoSpec,
      hostLabel: agents.hostLabel,
      modelId: agents.modelId,
      enabled: agents.enabled,
      workspacePath: agents.workspacePath,
      rootedAtReposDir: agents.rootedAtReposDir,
      createdAt: agents.createdAt,
      lastSeenAt: agents.lastSeenAt,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .where(eq(agents.id, agentId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const { ownerPubkey, ...rest } = row;
  return {
    ...rest,
    ownerName: displayName({ name: row.ownerName, pubkey: ownerPubkey }),
    scopes: parseScopes(row.scopes),
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt?.getTime() ?? null,
    revokedAt: row.revokedAt?.getTime() ?? null,
  };
}

/**
 * May this user administer this agent? Owners always can; workspace owners and
 * admins can administer anyone's.
 */
export async function canAdministerAgent(
  db: Database,
  userId: string,
  agent: { ownerUserId: string; workspaceId: string },
): Promise<boolean> {
  if (agent.ownerUserId === userId) return true;

  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, agent.workspaceId),
        eq(memberships.userId, userId),
      ),
    )
    .limit(1);

  const role = rows[0]?.role;
  return role === 'owner' || role === 'admin';
}

// --- presence --------------------------------------------------------------

export async function touchAgent(db: Database, agentId: string): Promise<void> {
  await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agentId));
}

export async function setAgentStatus(
  db: Database,
  agentId: string,
  status: string,
): Promise<void> {
  await db
    .update(agents)
    .set({ status: status.slice(0, AGENT_STATUS_MAX_LENGTH), lastSeenAt: new Date() })
    .where(eq(agents.id, agentId));
}

/**
 * Record where an agent is rooted, as its harness reported it.
 *
 * Kept on the agent rather than derived, because the office has no way to know
 * — and because an owner deserves to see "this one can reach every repo I have"
 * without reading a config file on another machine.
 */
export async function setAgentWorkspace(
  db: Database,
  agentId: string,
  workspacePath: string,
  rootedAtReposDir: boolean,
): Promise<void> {
  await db
    .update(agents)
    .set({ workspacePath: workspacePath.slice(0, 512), rootedAtReposDir })
    .where(eq(agents.id, agentId));
}

/**
 * Assign an existing agent to a machine, or unassign it.
 *
 * Separate from creation because the two orderings are both natural: you might
 * register a machine and then make agents for it, or make an agent today and
 * decide where it runs tomorrow. Requiring the first was an artefact of the
 * form, not a rule about agents.
 *
 * Null unassigns by clearing the *machine only*, deliberately keeping the
 * runtime and repo. `assignedToHost` already refuses an agent with no machine,
 * so nothing runs it — and keeping the rest means flipping it back on is one
 * click rather than retyping choices the UI just threw away. "Nowhere" means
 * not assigned, not amnesia.
 */
export async function setAgentLaunch(
  db: Database,
  agentId: string,
  launch: {
    runtimeId: string;
    repoSpec: string;
    hostLabel: string;
    /** Null, or absent, for the runtime's default. */
    modelId?: string | null;
  } | null,
): Promise<void> {
  await db
    .update(agents)
    .set(
      launch
        ? {
            runtimeId: launch.runtimeId,
            repoSpec: launch.repoSpec.slice(0, 512),
            hostLabel: launch.hostLabel,
            modelId: launch.modelId ? launch.modelId.slice(0, 128) : null,
          }
        : { hostLabel: null },
    )
    .where(eq(agents.id, agentId));
}

/**
 * Whether a host that pulls its fleet should be running this agent.
 *
 * Distinct from revoking, and deliberately so: revoking destroys a credential
 * and cannot be undone, while this is a switch. `fleetForHost` already filters
 * on it, and the harness reconciles rather than restarts — so flipping it stops
 * or starts one agent and leaves the rest of the fleet alone.
 */
export async function setAgentEnabled(
  db: Database,
  agentId: string,
  enabled: boolean,
): Promise<void> {
  await db.update(agents).set({ enabled }).where(eq(agents.id, agentId));
}

// --- audit log -------------------------------------------------------------

export async function recordAgentEvent(
  db: Database,
  agentId: string,
  kind: AgentEventKind,
  payload?: unknown,
): Promise<void> {
  await db.insert(agentEvents).values({
    id: newId(),
    agentId,
    // Derived here rather than passed in. A caller that had to supply the
    // office could supply the wrong one; a subquery against the agent being
    // written about cannot.
    workspaceId: sql`(select ${agents.workspaceId} from ${agents} where ${agents.id} = ${agentId})`,
    kind,
    payload: payload ?? null,
  });
}

export interface AgentEventPage {
  events: Array<{ id: string; kind: string; payload: unknown; createdAt: number }>;
  hasMore: boolean;
}

export async function listAgentEvents(
  db: Database,
  agentId: string,
  workspaceId: string,
  options: { kind?: string; limit?: number; before?: number } = {},
): Promise<AgentEventPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);

  // Both, always. The agent id alone would be enough today, because an agent
  // belongs to one office — but that is a fact a caller has to know, and the
  // point of the column is that a reader cannot forget it. An id from another
  // office returns nothing here rather than its log.
  const filters = [
    eq(agentEvents.agentId, agentId),
    eq(agentEvents.workspaceId, workspaceId),
  ];
  if (options.kind) filters.push(eq(agentEvents.kind, options.kind));
  if (options.before !== undefined) {
    filters.push(sql`${agentEvents.createdAt} < ${options.before}`);
  }

  const rows = await db
    .select()
    .from(agentEvents)
    .where(and(...filters))
    .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
    .limit(limit + 1);

  const events = rows.slice(0, limit).map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAt.getTime(),
  }));

  return { events, hasMore: rows.length > limit };
}

/** Distinct event kinds this agent has produced, for the log's filter menu. */
export async function listAgentEventKinds(
  db: Database,
  agentId: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ kind: agentEvents.kind })
    .from(agentEvents)
    .where(
      and(eq(agentEvents.agentId, agentId), eq(agentEvents.workspaceId, workspaceId)),
    );
  return rows.map((row) => row.kind).sort();
}

// --- memory ----------------------------------------------------------------

export class MemoryLimitError extends Error {
  constructor(
    readonly slug: string,
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`"${slug}" is ${bytes} bytes, over the ${limit} byte limit`);
    this.name = 'MemoryLimitError';
  }
}

export class MemorySlugError extends Error {
  constructor(readonly slug: string) {
    super(`"${slug}" is not a valid memory slug (lowercase letters, digits, hyphens)`);
    this.name = 'MemorySlugError';
  }
}

export async function getAgentMemory(
  db: Database,
  agentId: string,
  workspaceId: string,
  slug: string,
): Promise<{ slug: string; content: string; updatedAt: number } | null> {
  if (!isValidMemorySlug(slug)) throw new MemorySlugError(slug);

  const rows = await db
    .select()
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.agentId, agentId),
        eq(agentMemory.workspaceId, workspaceId),
        eq(agentMemory.slug, slug),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { slug: row.slug, content: row.content, updatedAt: row.updatedAt.getTime() };
}

/**
 * Write a memory slug. Over-size writes are **rejected, not truncated** — an
 * agent silently losing the tail of what it just saved is a worse failure than
 * an error it can react to.
 */
export async function setAgentMemory(
  db: Database,
  agentId: string,
  slug: string,
  content: string,
): Promise<{ slug: string; bytes: number }> {
  if (!isValidMemorySlug(slug)) throw new MemorySlugError(slug);

  const bytes = Buffer.byteLength(content, 'utf8');
  const limit = memoryLimitFor(slug);
  if (bytes > limit) throw new MemoryLimitError(slug, bytes, limit);

  await db
    .insert(agentMemory)
    .values({
      agentId,
      workspaceId: sql`(select ${agents.workspaceId} from ${agents} where ${agents.id} = ${agentId})`,
      slug,
      content,
    })
    .onConflictDoUpdate({
      target: [agentMemory.agentId, agentMemory.slug],
      set: { content, updatedAt: new Date() },
    });

  return { slug, bytes };
}

export async function listAgentMemorySlugs(
  db: Database,
  agentId: string,
  workspaceId: string,
): Promise<Array<{ slug: string; bytes: number; updatedAt: number }>> {
  const rows = await db
    .select()
    .from(agentMemory)
    .where(
      and(eq(agentMemory.agentId, agentId), eq(agentMemory.workspaceId, workspaceId)),
    );

  return rows.map((row) => ({
    slug: row.slug,
    bytes: Buffer.byteLength(row.content, 'utf8'),
    updatedAt: row.updatedAt.getTime(),
  }));
}
