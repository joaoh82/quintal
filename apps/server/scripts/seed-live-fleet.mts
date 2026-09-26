/**
 * Seed the *fleet* path: an office-defined agent, launched by a host token.
 *
 * QUIN-53's review found that this is the shape almost every agent has and the
 * one nothing had ever exercised. `host.ts` builds an office-defined agent with
 * `harness: 'custom'` and its real runtime in `runtimeId` — the command comes
 * from the catalogue, so the spawn carries no harness id — and every permission
 * fact keyed on `harness` was therefore silently lost here, including the
 * plan-exit safeguard. A probe that boots `--agent omp` by hand cannot see
 * that, because it puts the runtime in `harness` itself.
 *
 * So this seeds what `quintal-acp up` needs and nothing else: an agent with a
 * launch definition (runtime + machine), a channel it is in, and a host token
 * for that machine.
 *
 *   DATABASE_URL=file:/tmp/... QUIN53_RUNTIME=omp \
 *     pnpm exec tsx apps/server/scripts/seed-live-fleet.mts
 */
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';

import { runtimeById } from '@quintal/shared';
import {
  addChannelMember,
  createAgent,
  createChannel,
  createHostToken,
  getDb,
  memberships,
  sessions,
  users,
} from '@quintal/shared/db';

assert.ok(process.env.DATABASE_URL?.startsWith('file:/tmp/'), 'Use an isolated temporary database');

const runtimeId = process.env.QUIN53_RUNTIME ?? 'omp';
const spec = runtimeById(runtimeId);
assert.ok(spec, `unknown runtime "${runtimeId}"`);
assert.notEqual(spec.acp.kind, 'none', `${runtimeId} has no ACP mode to drive`);

// Scopes default to the `run` case, because the automatic path is the one the
// bug lived on: with `run` nobody is asked, so nothing but the audit row can
// say which of the runtime's options was taken.
const scopes = (process.env.QUIN_SCOPES ?? 'chat,status,dm,run')
  .split(',')
  .map((scope) => scope.trim())
  .filter(Boolean) as Parameters<typeof createAgent>[1]['scopes'];

const db = getDb();
const [owner] = await db.select().from(users).limit(1);
assert.ok(owner, 'no user — run the HTTP smoke once to create an identity');
const [membership] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
assert.ok(membership);
const workspaceId = membership.workspaceId;
const [session] = await db.select().from(sessions).where(eq(sessions.userId, owner.id));
assert.ok(session);

const stamp = Date.now().toString(36);
// The label is the machine's name, and the fleet endpoint filters on it: a
// fleet assigned to "laptop" must not boot on the build box.
const hostLabel = `probe-${stamp}`;
const channel = await createChannel(db, { workspaceId, name: `Fleet ${stamp}`, createdBy: owner.id });
const agent = await createAgent(db, {
  workspaceId,
  ownerUserId: owner.id,
  name: `Fleet${stamp.slice(-4)}`,
  spriteKey: 'slate',
  scopes,
  // The launch definition is what makes this an office-*defined* agent, and so
  // what makes `host.ts` build it with `harness: 'custom'`.
  launch: { runtimeId, hostLabel, modelId: null },
});
await addChannelMember(db, {
  channelId: channel.id,
  memberId: agent.id,
  memberKind: 'agent',
  addedBy: owner.id,
});
const host = await createHostToken(db, { workspaceId, ownerUserId: owner.id, label: hostLabel });

console.log(
  JSON.stringify(
    {
      workspaceId,
      ownerId: owner.id,
      ownerName: owner.name,
      token: session.token,
      agentId: agent.id,
      agentName: agent.name,
      scopes,
      runtimeId,
      hostLabel,
      hostToken: host.token,
      channelId: channel.id,
      channelName: channel.name,
    },
    null,
    2,
  ),
);
process.exit(0);
