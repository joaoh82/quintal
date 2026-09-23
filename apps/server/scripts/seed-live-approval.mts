/** Seed one agent with NO `run` scope, plus a channel with its owner, for the
 * QUIN-52 live-runtime probe. Prints the agent key and channel id as JSON. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, createAgent, createChannel, addChannelMember, users, sessions, memberships } from '@quintal/shared/db';

assert.ok(process.env.DATABASE_URL?.startsWith('file:/tmp/'), 'Use an isolated temporary database');
const db = getDb();
const [owner] = await db.select().from(users).limit(1);
assert.ok(owner);
const [membership] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
assert.ok(membership);
const workspaceId = membership.workspaceId;
const [session] = await db.select().from(sessions).where(eq(sessions.userId, owner.id));
assert.ok(session);

const stamp = Date.now().toString(36);
const channel = await createChannel(db, { workspaceId, name: `Live ${stamp}`, createdBy: owner.id });
// Deliberately no `run`: the whole point is that the owner is asked.
const agent = await createAgent(db, {
  workspaceId, ownerUserId: owner.id, name: `Probe${stamp.slice(-4)}`, spriteKey: 'slate',
  scopes: ['chat', 'status', 'dm'],
});
await addChannelMember(db, { channelId: channel.id, memberId: agent.id, memberKind: 'agent', addedBy: owner.id });
console.log(JSON.stringify({
  workspaceId, ownerId: owner.id, ownerName: owner.name,
  token: session.token, agentId: agent.id, agentKey: agent.key, agentName: agent.name,
  channelId: channel.id, channelName: channel.name, nonce: randomUUID(),
}, null, 2));
process.exit(0);
