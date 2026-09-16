/** Local QUIN-49 protocol smoke. Use an isolated DB and an already-running office.
 * DATABASE_URL=file:/tmp/... pnpm exec tsx apps/server/scripts/smoke-activity.mts
 * Set QUIN49_HOLD=1 to leave the agents alive for browser/desktop inspection.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client, type Room } from 'colyseus.js';
import { eq } from 'drizzle-orm';
import {
  type AgentActivity,
  type PublicActivity,
  ClientMessage,
  ServerMessage,
} from '@quintal/shared';
import {
  getDb,
  createAgent,
  createChannel,
  addChannelMember,
  users,
  sessions,
  memberships,
  agentActivity,
  openDm,
} from '@quintal/shared/db';
import { createTestUser } from '@quintal/shared/db/testing';
const base = process.env.QUIN49_URL ?? 'http://127.0.0.1:3049';
const output = process.env.QUIN49_OUTPUT ?? '/tmp/quin49-verification';
assert.ok(process.env.DATABASE_URL?.startsWith('file:/tmp/'), 'Use an isolated temporary database');
const db = getDb();
const requestedOwner = process.env.QUIN49_OWNER_ID;
const [owner] = requestedOwner
  ? await db.select().from(users).where(eq(users.id, requestedOwner)).limit(1)
  : await db.select().from(users).limit(1);
assert.ok(owner, 'Run scripts/smoke.mjs first');
mkdirSync(output, { recursive: true });
await db.update(users).set({ name: 'Verification Owner' }).where(eq(users.id, owner.id));
const [membership] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
assert.ok(membership);
const workspaceId = membership.workspaceId;
const [session] = await db.select().from(sessions).where(eq(sessions.userId, owner.id));
assert.ok(session);
const outsider = await createTestUser(db, 'Outside channel', { workspaceId });
await db.insert(memberships).values({
  id: randomUUID(),
  workspaceId,
  userId: outsider.id,
  role: 'member',
});
const outsiderToken = randomUUID();
await db.insert(sessions).values({
  id: randomUUID(),
  token: outsiderToken,
  userId: outsider.id,
  expiresAt: new Date(Date.now() + 3600000),
});
const stamp = Date.now().toString(36);
const alpha = await createChannel(db, {
  workspaceId,
  name: `Activity ${stamp}`,
  createdBy: owner.id,
});
const beta = await createChannel(db, {
  workspaceId,
  name: `Parallel ${stamp}`,
  createdBy: owner.id,
});
const a = await createAgent(db, {
  workspaceId,
  ownerUserId: owner.id,
  name: 'Probe Alpha',
  spriteKey: 'slate',
  scopes: ['chat', 'status', 'dm', 'run'],
});
const b = await createAgent(db, {
  workspaceId,
  ownerUserId: owner.id,
  name: 'Probe Beta',
  spriteKey: 'slate',
  scopes: ['chat', 'status', 'dm', 'run'],
});
for (const channel of [alpha, beta])
  for (const agent of [a, b])
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: agent.id,
      memberKind: 'agent',
      addedBy: owner.id,
    });
const dm = await openDm(db, {
  workspaceId,
  openerId: owner.id,
  other: { id: a.id, kind: 'agent' },
});
writeFileSync(
  output + '/seed.json',
  JSON.stringify(
    {
      workspaceId,
      ownerId: owner.id,
      token: session.token,
      a,
      b,
      alpha,
      beta,
      dm,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const rooms: Room[] = [];
const received: PublicActivity[] = [];
const leaked: PublicActivity[] = [];
let wakeups = 0;
const connect = async (options: object) => {
  const room = await new Client(base + '/colyseus').joinOrCreate('office', {
    mapId: 'hq',
    workspaceId,
    ...options,
  });
  room.onMessage('*', () => {});
  rooms.push(room);
  return room;
};
const human = await connect({ token: session.token });
human.onMessage('activity', (v: PublicActivity) => received.push(v));
const stranger = await connect({ token: outsiderToken });
stranger.onMessage('activity', (v: PublicActivity) => leaked.push(v));
const agentA = await connect({ agentKey: a.key });
const agentB = await connect({ agentKey: b.key });
agentB.onMessage('agent:channel_chat', () => wakeups++);
agentB.onMessage('agent:mention', () => wakeups++);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, label: string) => {
  const end = Date.now() + 5000;
  while (!test()) {
    assert.ok(Date.now() < end, label);
    await sleep(20);
  }
};
const make = (channelId: string, turnId: string): AgentActivity => ({
  version: 1,
  turnId,
  requestId: turnId,
  workerId: 'worker-1',
  sessionId: 'session-1',
  sequence: 1,
  channelId,
  state: 'queued',
  startedAt: Date.now(),
  updatedAt: Date.now(),
  items: [],
});
await sleep(11_000); // The already-running room refreshes externally seeded membership every 10s.
const t1 = make(alpha.id, randomUUID()),
  t2 = make(beta.id, randomUUID());
const send = (r: Room, v: AgentActivity) => r.send('agent:activity', structuredClone(v));
try {
  const sentAt = Date.now();
  send(agentA, t1);
  send(agentB, t2);
  await until(
    () =>
      received.some((v) => v.turnId === t1.turnId) && received.some((v) => v.turnId === t2.turnId),
    'concurrent queue feedback',
  );
  const queueLatencyMs = Date.now() - sentAt;
  t1.sequence = 2;
  t1.state = 'running';
  t1.items = [
    {
      id: 'narration',
      kind: 'message',
      text: 'Checking three commands.',
      state: 'success',
      startedAt: Date.now(),
    },
  ];
  for (const [i, command] of ['ls /workspace', 'uname -a', 'false'].entries()) {
    t1.items.push({
      id: `tool-${i}`,
      kind: 'tool',
      text: command,
      state: 'running',
      startedAt: Date.now(),
      detail: 'token=secret-value',
    });
    t1.sequence++;
    send(agentA, t1);
    await sleep(150);
    t1.items.at(-1)!.state = i === 2 ? 'failed' : 'success';
    t1.items.at(-1)!.endedAt = Date.now();
    t1.sequence++;
    send(agentA, t1);
    await sleep(150);
  }
  await until(
    () => received.some((v) => v.turnId === t1.turnId && v.items.at(-1)?.state === 'failed'),
    'failed row before final',
  );
  const latest = received.filter((v) => v.turnId === t1.turnId).at(-1)!;
  assert.equal(latest.agentId, a.id);
  assert.ok(!JSON.stringify(latest).includes('secret-value'));
  send(agentA, { ...t1, sequence: 1, state: 'queued' });
  send(agentA, { ...t1, channelId: beta.id, sequence: 99 });
  send(human, { ...t1, turnId: 'forged-human' });
  send(agentA, { ...t1, channelId: 'not-a-member', turnId: 'forged-channel' });
  await sleep(300);
  assert.ok(
    !received.some(
      (v) =>
        v.turnId === 'forged-human' ||
        v.turnId === 'forged-channel' ||
        (v.turnId === t1.turnId && v.channelId === beta.id),
    ),
  );
  assert.equal(leaked.length, 0);
  assert.equal(wakeups, 0);
  const dmTurn = make(dm.id, randomUUID());
  send(agentA, dmTurn);
  await until(() => received.some((v) => v.turnId === dmTurn.turnId), 'DM delivered');
  assert.equal(leaked.length, 0);
  const history: any[] = [];
  human.onMessage(ServerMessage.History, (v) => history.push(v));
  human.send(ClientMessage.HistoryGet, { channelId: alpha.id });
  await until(() => history.length > 0, 'history response');
  assert.equal(
    history.at(-1).messages.filter((v: any) => v.activity?.turnId === t1.turnId).length,
    1,
  );
  const newer = make(alpha.id, randomUUID());
  newer.state = 'completed';
  send(agentA, newer);
  await until(() => received.some((v) => v.turnId === newer.turnId), 'newer completed turn');
  const beforeReplay = received.filter((v) => v.turnId === t1.turnId).length;
  human.send(ClientMessage.HistoryGet, { channelId: alpha.id, n: 1 });
  await until(
    () => received.filter((v) => v.turnId === t1.turnId).length > beforeReplay,
    'active turn recovered beyond history page',
  );

  const denied: any[] = [];
  stranger.onMessage(ServerMessage.Error, (v) => denied.push(v));
  stranger.send(ClientMessage.HistoryGet, { channelId: alpha.id });
  await until(() => denied.length > 0, 'restricted history denied');
  await agentA.leave(true);
  rooms.splice(rooms.indexOf(agentA), 1);
  await until(
    () => received.some((v) => v.turnId === t1.turnId && v.state === 'disconnected'),
    'disconnect closed row',
  );
  const resumed = await connect({ agentKey: a.key });
  t1.sequence++;
  send(resumed, t1);
  await until(
    () =>
      received.some(
        (v) => v.turnId === t1.turnId && v.sequence === t1.sequence && v.state === 'running',
      ),
    'reconnect restored turn',
  );
  t1.sequence++;
  t1.state = 'completed';
  t1.items.push({
    id: 'reply',
    kind: 'message',
    text: 'The directory listing and system check succeeded; false exited with code 1.',
    state: 'success',
    startedAt: Date.now(),
  });
  send(resumed, t1);
  t2.sequence++;
  t2.state = 'cancelled';
  send(agentB, t2);
  await until(
    () => received.some((v) => v.turnId === t1.turnId && v.state === 'completed'),
    'completed',
  );
  send(resumed, { ...t1, sequence: 999, state: 'running' });
  await sleep(200);
  assert.ok(!received.some((v) => v.turnId === t1.turnId && v.sequence === 999));
  const rows = await db
    .select()
    .from(agentActivity)
    .where(eq(agentActivity.workspaceId, workspaceId));
  assert.equal(rows.filter((r) => JSON.parse(r.snapshot).turnId === t1.turnId).length, 1);
  const report = {
    pass: true,
    queueLatencyMs,
    receivedSnapshots: received.length,
    leakedSnapshots: leaked.length,
    agentWakeups: wakeups,
    turnId: t1.turnId,
    channel: alpha.name,
    dbRows: rows.map((r) => ({
      id: r.id,
      sequence: r.sequence,
      state: JSON.parse(r.snapshot).state,
    })),
    restrictedHistory: denied[0],
  };
  writeFileSync(output + '/protocol-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.QUIN49_HOLD === '1') {
    console.log('Holding agents for visual verification');
    await new Promise(() => {});
  }
} finally {
  await Promise.allSettled(rooms.map((r) => r.leave(true)));
}
process.exit(0);
