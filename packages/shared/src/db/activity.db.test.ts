import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { agentActivity } from './schema.js';
import type { PublicActivity } from '../activity.js';
import { createTestDb, createTestUser } from './testing.js';
import { ensureZoneConversations } from './messages.js';
import { findActivity, keepActivity, readActivity } from './activity.js';

test('migration, durable upserts, office isolation, spatial history and sequence ordering', async () => {
  const db = await createTestDb();
  const owner = await createTestUser(db, 'Owner');
  const other = await createTestUser(db, 'Other');
  const zones = await ensureZoneConversations(db, owner.workspaceId, 'hq', [
    { id: 'lobby', label: 'Lobby' },
  ]);
  const conversationId = zones.get('lobby')!;
  const value: PublicActivity = {
    version: 1,
    agentId: 'agent',
    agentName: 'Agent',
    turnId: 'turn',
    workerId: '0',
    sessionId: 'session',
    requestId: 'request',
    sequence: 2,
    state: 'running',
    startedAt: 10,
    updatedAt: 11,
    receivedAt: 12,
    zoneId: 'lobby',
    items: [],
  };
  await keepActivity(db, conversationId, owner.workspaceId, value, {
    x: 10,
    y: 10,
  });
  await keepActivity(
    db,
    conversationId,
    owner.workspaceId,
    { ...value, sequence: 1, state: 'queued' },
    { x: 10, y: 10 },
  );
  const target = { conversationId, mapId: 'hq', x: 10, y: 10, radius: 2 };
  assert.equal((await readActivity(db, owner.workspaceId, target))[0]?.state, 'running');
  assert.deepEqual(await readActivity(db, other.workspaceId, target), []);
  assert.deepEqual(
    await readActivity(db, owner.workspaceId, {
      ...target,
      conversationId: undefined,
      x: 100,
    }),
    [],
  );
  await keepActivity(
    db,
    conversationId,
    owner.workspaceId,
    { ...value, state: 'disconnected', receivedAt: 13 },
    { x: 10, y: 10 },
  );
  assert.equal((await readActivity(db, owner.workspaceId, target))[0]?.state, 'disconnected');
  await keepActivity(db, conversationId, owner.workspaceId, value, null);
  assert.equal((await readActivity(db, owner.workspaceId, target))[0]?.state, 'disconnected');

  // Reproduce a row already written by 0029, then apply the data-only upgrade.
  await db.update(agentActivity).set({ id: 'agent:turn' });
  await db.run(
    sql.raw(
      readFileSync(new URL('../../drizzle/0030_scope_activity_ids.sql', import.meta.url), 'utf8'),
    ),
  );
  assert.equal(
    (await findActivity(db, owner.workspaceId, 'agent', 'turn'))?.activity.state,
    'disconnected',
  );

  const otherZones = await ensureZoneConversations(db, other.workspaceId, 'hq', [
    { id: 'lobby', label: 'Lobby' },
  ]);
  const otherId = otherZones.get('lobby')!;
  await keepActivity(db, otherId, other.workspaceId, value, null);
  assert.equal(
    (await findActivity(db, other.workspaceId, 'agent', 'turn'))?.activity.state,
    'running',
  );
  assert.equal(
    (await findActivity(db, owner.workspaceId, 'agent', 'turn'))?.activity.state,
    'disconnected',
  );

  // A future writer cannot replay extra/private fields or malformed JSON.
  const key = `${other.workspaceId}:agent:turn`;
  await db
    .update(agentActivity)
    .set({ snapshot: JSON.stringify({ ...value, thought: 'private', nearby: true }) })
    .where(eq(agentActivity.id, key));
  const found = await findActivity(db, other.workspaceId, 'agent', 'turn');
  assert.deepEqual(found?.activity, value);
  assert.equal('snapshot' in found!, false);
  assert.deepEqual(
    await readActivity(db, other.workspaceId, { ...target, conversationId: otherId }),
    [value],
  );
  await db.update(agentActivity).set({ snapshot: '{broken' }).where(eq(agentActivity.id, key));
  assert.equal(await findActivity(db, other.workspaceId, 'agent', 'turn'), undefined);
  assert.deepEqual(
    await readActivity(db, other.workspaceId, { ...target, conversationId: otherId }),
    [],
  );
});
