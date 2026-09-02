import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { AGENT_SCOPES } from '../agent.js';
import { MEMBERSHIP_ROLES } from '../workspace.js';

/*
 * SQLite / libSQL only. Keep every column type portable: the same schema has to
 * run against a local `file:` database and against a remote `libsql://` (Turso)
 * one without changes. No Postgres-specific types, ever.
 *
 * Timestamps are stored as integer milliseconds (`timestamp_ms`) because that is
 * what Better Auth's Drizzle adapter expects.
 */

const now = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

// ---------------------------------------------------------------------------
// Better Auth tables (plural names; the adapter is configured with usePlural)
// ---------------------------------------------------------------------------

/**
 * A human, identified by a public key.
 *
 * There is no email column and no password column, because there is no email
 * and no password: you prove who you are by signing a challenge with a key you
 * hold. That removes the whole class of things a self-hoster would otherwise
 * have to operate and defend — a mail provider, deliverability, a reset flow,
 * an inbox as the de-facto root credential for every account.
 *
 * `pubkey` is the 32-byte x-only key in lowercase hex, not an npub: hex is what
 * signatures verify against, and storing exactly one encoding means two rows
 * can never disagree about whether they are the same person. The npub is a
 * rendering, produced at the edges.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pubkey: text('pubkey').notNull().unique(),
  /**
   * May change settings that belong to the whole deployment.
   *
   * Recorded rather than worked out. The first version of this asked "who is
   * the earliest account?" on every check, which is not a fact about the
   * instance — it is a query whose answer moves when accounts are deleted, and
   * it silently reassigned who was in charge the first time somebody tidied up
   * a test user.
   *
   * Not a role and not a panel: the plan cuts an admin panel, and this is the
   * smaller thing underneath it — one bit saying who may touch instance-wide
   * settings, granted with `pnpm admin` and nowhere else for now.
   */
  instanceAdmin: integer('instance_admin', { mode: 'boolean' }).notNull().default(false),
  /**
   * A line under your name, shown on your profile card. Self-asserted and
   * length-capped — it is rendered next to other people's names, so it is
   * untrusted input like any other.
   */
  description: text('description').notNull().default(''),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(now)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(now)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Set for sessions minted by walking in through a guest link.
     *
     * On the session rather than the user because it is the *arrival* that was
     * provisional, not the person: the same key coming back through a normal
     * sign-in is not a guest. It also means a guest badge cannot outlive the
     * visit that earned it.
     */
    isGuest: integer('is_guest', { mode: 'boolean' }).notNull().default(false),
    /**
     * The one office a guest was let into.
     *
     * A guest has no membership on purpose — a membership outlives the visit,
     * and a forwarded link would become a standing key to the place. So the
     * grant lives here, bounded by the session, and the room gate reads it.
     *
     * This is the other half of that decision finally landing: until offices
     * were scoped there was no gate to read it, because every room held every
     * workspace at once.
     */
    guestWorkspaceId: text('guest_workspace_id').references(() => workspaces.id, {
      onDelete: 'cascade',
    }),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
);

/**
 * Login nonces.
 *
 * `identifier` is the public key being challenged and `value` is the 32-byte
 * hex nonce we issued for it, with a 60-second expiry. Better Auth owns this
 * table's shape, and consuming a row is atomic — which is what makes a nonce
 * single-use rather than merely short-lived.
 */
export const verifications = sqliteTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

// ---------------------------------------------------------------------------
// Quintal tables
// ---------------------------------------------------------------------------

/**
 * A workspace is one office. Solo-first: every user gets a personal workspace
 * on first sign-in, and other humans can be invited into it later.
 */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(now)
    .notNull(),
});

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
  },
  (table) => [
    uniqueIndex('memberships_workspace_user_unique').on(
      table.workspaceId,
      table.userId,
    ),
    index('memberships_user_id_idx').on(table.userId),
  ],
);

/**
 * A link that lets somebody walk into the office without having an identity
 * first.
 *
 * The token is stored as a SHA-256 hash for the same reason agent keys are: a
 * leaked database should not hand an attacker a working door. The `v2.` prefix
 * on the plaintext is a version marker carried outside the hash, so a future
 * token format can be told apart on sight rather than by trying to validate it.
 *
 * Bounded twice over — by `expiresAt` and by `maxUses` — because a guest link
 * is pasted into chats and forwarded, and the person who created it is not the
 * only one who will ever hold it.
 */
export const inviteLinks = sqliteTable(
  'invite_links',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** SHA-256 of the plaintext token, hex. The plaintext is shown once. */
    tokenHash: text('token_hash').notNull().unique(),
    /** What the guest becomes on the way in. */
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull().default('member'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
    /** Set instead of deleting, so a spent link stays explainable. */
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [index('invite_links_workspace_id_idx').on(table.workspaceId)],
);

/**
 * What belongs to the whole deployment. One row, id 'global'.
 *
 * The radii that used to justify a "not per-workspace yet" note live in
 * `officeSettings` now, one row per office.
 */
export const instanceSettings = sqliteTable('instance_settings', {
  id: text('id').primaryKey(),
  /**
   * What this deployment calls itself, shown before anybody signs in.
   *
   * Not a workspace's name — that one belongs to a person and is also displayed
   * as an office. This belongs to the instance, and is what somebody arriving
   * at a URL sees before they have an account here.
   */
  name: text('name').notNull().default(''),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(now)
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * How one office's room behaves.
 *
 * Keyed by workspace, because an office is a workspace. These used to live in a
 * single 'global' row alongside the instance name, which meant every office on
 * a deployment shared them — how close you had to stand to be heard was a
 * property of the server rather than of your office.
 *
 * A missing row means defaults, so an office does not need one until somebody
 * changes something. Migration 0013 seeded a row for every office that existed
 * when it ran, carrying the values the whole instance had been sharing — so in
 * practice the missing-row path is for offices created since.
 */
export const officeSettings = sqliteTable('office_settings', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  chatRadiusTiles: integer('chat_radius_tiles').notNull().default(12),
  walkUpRadiusTiles: integer('walk_up_radius_tiles').notNull().default(3),
  replyWindowSeconds: integer('reply_window_seconds').notNull().default(90),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(now)
    .$onUpdate(() => new Date())
    .notNull(),
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * An agent belongs to a workspace and to exactly one human. That ownership is
 * not decoration: it is who answers for what the agent does, and it is shown
 * everywhere the agent appears.
 *
 * Keys are stored as a SHA-256 hash. The plaintext is shown once, at creation,
 * and never again — a leaked database gives an attacker nothing to connect with.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    spriteKey: text('sprite_key').notNull().default('slate'),
    /**
     * One line about what this agent does, written by its owner.
     *
     * For people: it sits on the agent's card next to its name, the way a
     * human's profile line does. Display text, contained like every other label.
     */
    description: text('description').notNull().default(''),
    /**
     * How its owner told it to behave, prepended to its system prompt.
     *
     * A different thing from `description` and from core memory, and the three
     * are kept apart on purpose. A description is a label humans read. This is
     * a directive the model reads. Core memory is what the agent worked out for
     * itself. Same prompt, three authors — collapsing them would mean a
     * personality note is also a nameplate, and that an agent could rewrite
     * what its owner told it to be.
     */
    instructions: text('instructions').notNull().default(''),
    apiKeyHash: text('api_key_hash').notNull().unique(),
    /** JSON array of AgentScope. Text, because SQLite has no array type. */
    scopes: text('scopes', { mode: 'json' })
      .$type<(typeof AGENT_SCOPES)[number][]>()
      .notNull()
      .default(['chat', 'move', 'status']),
    /** Presence line, mirrored into room state while connected. */
    status: text('status').notNull().default(''),
    /**
     * The directory this agent is rooted at, as its harness reported it.
     *
     * Shown wherever the agent is, because "what can this thing read and
     * write" is exactly the fact that should be legible — the same reason its
     * owner's name follows it around.
     */
    workspacePath: text('workspace_path').notNull().default(''),
    /** True when rooted at the whole repos directory rather than one checkout. */
    rootedAtReposDir: integer('rooted_at_repos_dir', { mode: 'boolean' })
      .notNull()
      .default(false),

    // --- how a host should launch this agent, when the office defines it ---
    //
    // Null throughout means "not office-defined": an agent created before this
    // existed, or one you launch by hand with its own key. Those keep working
    // exactly as they did; nothing here is a migration.
    /** Runtime id from the shared catalogue — `claude-code`, `goose`, … */
    runtimeId: text('runtime_id'),
    /**
     * Workspace as written by the person, not as resolved.
     *
     * A repo name, `*` for the whole repos directory, or an absolute path. Kept
     * unresolved because it resolves differently on different machines, and the
     * office is not the machine.
     */
    repoSpec: text('repo_spec'),
    /** Which machine should run it, matching `agent_hosts.label`. */
    hostLabel: text('host_label'),
    /** Whether a host that pulls its fleet should be running this. */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Last time this agent did anything at all. Drives "last seen" in the UI. */
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
    /** Set instead of deleting: an audit log with dangling agent ids is useless. */
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('agents_workspace_id_idx').on(table.workspaceId),
    index('agents_owner_user_id_idx').on(table.ownerUserId),
  ],
);

/**
 * The audit log. Every inbound command and every outbound consequence lands
 * here, so "what has this thing been doing" is answerable without trusting the
 * agent's own account of itself.
 */
/**
 * A machine that can host agents.
 *
 * The office cannot see anybody's PATH — and a hosted Quintal never will — so
 * which runtimes exist is something a machine reports inward, not something we
 * discover. One row per (workspace, machine), refreshed whenever a harness
 * connects, so the settings page can show what you could run *here* rather
 * than a generic list of what exists in the world.
 */
export const agentHosts = sqliteTable(
  'agent_hosts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hostname, for telling two machines apart. */
    label: text('label').notNull(),
    /** Where this machine keeps repositories — its `reposDir`. */
    reposDir: text('repos_dir').notNull().default(''),
    /** JSON array of RuntimeStatus, normalised before it is stored. */
    runtimes: text('runtimes', { mode: 'json' })
      .$type<{ id: string; installed: boolean; path: string | null }[]>()
      .notNull()
      .default([]),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  },
  (table) => [uniqueIndex('agent_hosts_workspace_label').on(table.workspaceId, table.label)],
);

/**
 * A machine's credential.
 *
 * Exists so the office can *define* an agent that your laptop then runs. The
 * alternative — the office handing back agent keys it created — would mean
 * storing those keys recoverably rather than as hashes, which is a worse trade
 * than one revocable token that never leaves your machine.
 *
 * Scoped to one workspace and one owner: a host token may act as any agent that
 * owner has assigned to it, and nothing else.
 */
export const hostTokens = sqliteTable('host_tokens', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** What the person called this machine when they created the token. */
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(now).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  /** Set instead of deleting, same as agents: revocation is a fact worth keeping. */
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
});

export const agentEvents = sqliteTable(
  'agent_events',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * The office this event happened in.
     *
     * Redundant with the agent, and deliberately so. Scoping used to be
     * transitive — every reader happened to go through `agents`, which carries
     * the workspace — which made isolation a convention that one forgotten
     * join would break silently. Written from the agent in the same statement
     * that inserts the row, so the two cannot disagree.
     */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(now)
      .notNull(),
  },
  (table) => [
    // The log is always read newest-first for one agent, and often filtered by
    // kind; this index serves both.
    index('agent_events_agent_created_idx').on(table.agentId, table.createdAt),
    index('agent_events_kind_idx').on(table.kind),
    // Deliberately no index on `workspaceId` alone. It is low cardinality, and
    // with one the planner picked it for `listAgentEventKinds` — scanning every
    // event in the office and then filtering by agent, where the composite
    // above finds the agent's rows directly. It helped no query that exists and
    // made one worse. A whole-office query, if it ever arrives, wants
    // `(workspaceId, createdAt)`; the only other reader is a workspace delete
    // cascading, which is rare enough not to pay for on every write.
  ],
);

/**
 * Durable scratch space for an agent's harness, addressed by slug. `core` is
 * the one loaded on every turn and is held to a tighter size limit than the
 * rest — see AGENT_CORE_MEMORY_MAX_BYTES.
 */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** The office this memory belongs to — see `agentEvents.workspaceId`. */
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    content: text('content').notNull().default(''),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(now)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.slug] }),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type InviteLink = typeof inviteLinks.$inferSelect;
export type NewInviteLink = typeof inviteLinks.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentEvent = typeof agentEvents.$inferSelect;
export type NewAgentEvent = typeof agentEvents.$inferInsert;
export type AgentMemory = typeof agentMemory.$inferSelect;
export type OfficeSettingsRow = typeof officeSettings.$inferSelect;
export type InstanceSettingsRow = typeof instanceSettings.$inferSelect;
