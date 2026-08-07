/**
 * Create an agent from the command line and print its key.
 *
 * The settings page is the real path — it is where an owner sees the key once
 * and can revoke it. This exists because setting up a fleet by hand means
 * clicking through the UI once per agent, copying a key each time, and pasting
 * it somewhere before it disappears. That is fine for one agent and miserable
 * for five.
 *
 *   just agent-new reviewer
 *
 * Idempotent by name: running it again for an existing agent revokes the old
 * one and issues a fresh key, so re-running a setup script does the obvious
 * thing instead of accumulating duplicates.
 */
import {
  createAgent,
  ensurePersonalWorkspace,
  getDb,
  listAgentsForWorkspace,
  loadRootEnv,
  revokeAgent,
  users,
} from '@quintal/shared/db';
import { randomUUID } from 'node:crypto';

loadRootEnv();

const name = process.argv[2];
if (!name) {
  console.error('usage: just agent-new <name>');
  process.exit(1);
}

const email = process.env.SEED_EMAIL ?? 'demo@quintal.local';
const db = getDb();

// Prefer a real signed-in human over the local seed account: an agent's owner
// is shown on its avatar, in the roster and on every line of its audit log, so
// attributing your fleet to "Demo Human" defeats the point of attribution.
// Sign in first, then create agents, and they are yours.
const existing = await db.select().from(users).limit(50);
const owner =
  existing.find((user) => user.email !== email) ??
  existing.find((user) => user.email === email) ??
  (await (async () => {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      name: process.env.SEED_NAME ?? 'Demo Human',
      email,
      emailVerified: true,
    });
    return { id, name: process.env.SEED_NAME ?? 'Demo Human', email };
  })());

const workspace = await ensurePersonalWorkspace(db, {
  userId: owner.id,
  name: owner.name,
  email: owner.email,
});

const already = (await listAgentsForWorkspace(db, workspace.id)).find(
  (agent) => agent.name === name && agent.revokedAt === null,
);
if (already) {
  await revokeAgent(db, already.id, owner.id);
  console.error(`(revoked the previous "${name}" — keys cannot be re-read)`);
}

const created = await createAgent(db, {
  workspaceId: workspace.id,
  ownerUserId: owner.id,
  name,
  spriteKey: 'slate',
});

// The key alone on stdout, so `KEY=$(just agent-new x)` works.
console.error(`created "${created.name}" for ${owner.name} in ${workspace.name}`);
console.log(created.key);
