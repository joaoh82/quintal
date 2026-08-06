import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
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

/** Magic-link tokens live here (and email verification, later). */
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
