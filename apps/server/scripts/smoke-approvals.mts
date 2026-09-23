/** Local QUIN-52 protocol smoke. Use an isolated DB and an already-running office.
 * DATABASE_URL=file:/tmp/... pnpm exec tsx apps/server/scripts/smoke-approvals.mts
 * Set QUIN52_HOLD=1 to leave the cards up for browser/desktop inspection.
 *
 * What it proves, against the real gateway rather than a stub: who sees a
 * card, who may answer it, that two questions about the same tool in two
 * conversations are separate, that a stale or crafted answer is refused, and
 * that a card never outlives the agent holding it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client, type Room } from 'colyseus.js';
import { eq } from 'drizzle-orm';
import {
  ClientMessage,
  ServerMessage,
  type AgentApprovalDecisionEvent,
  type ApprovalRequest,
  type ErrorPayload,
  type HistoryPayload,
  type PublicApprovalRequest,
  type PublicApprovalResolved,
} from '@quintal/shared';
import {
  getDb,
  createAgent,
  createChannel,
  addChannelMember,
  users,
  sessions,
  memberships,
  openDm,
} from '@quintal/shared/db';
import { createTestUser } from '@quintal/shared/db/testing';

const base = process.env.QUIN52_URL ?? 'http://127.0.0.1:3052';
const output = process.env.QUIN52_OUTPUT ?? '/tmp/quin52-verification';
assert.ok(process.env.DATABASE_URL?.startsWith('file:/tmp/'), 'Use an isolated temporary database');
const db = getDb();
const requestedOwner = process.env.QUIN52_OWNER_ID;
const [owner] = requestedOwner
  ? await db.select().from(users).where(eq(users.id, requestedOwner)).limit(1)
  : await db.select().from(users).limit(1);
assert.ok(owner, 'Run scripts/smoke.mjs first');
mkdirSync(output, { recursive: true });
await db.update(users).set({ name: 'Approval Owner' }).where(eq(users.id, owner.id));
const [membership] = await db.select().from(memberships).where(eq(memberships.userId, owner.id));
assert.ok(membership);
const workspaceId = membership.workspaceId;
const [session] = await db.select().from(sessions).where(eq(sessions.userId, owner.id));
assert.ok(session);

/** A colleague in the channel, who may read the card but must never answer it. */
const colleague = await createTestUser(db, 'Colleague', { workspaceId });
/** Somebody in neither channel, who must never see one at all. */
const outsider = await createTestUser(db, 'Outsider', { workspaceId });
const tokens = new Map<string, string>();
for (const person of [colleague, outsider]) {
  await db.insert(memberships).values({
    id: randomUUID(),
    workspaceId,
    userId: person.id,
    role: 'member',
  });
  const token = randomUUID();
  await db.insert(sessions).values({
    id: randomUUID(),
    token,
    userId: person.id,
    expiresAt: new Date(Date.now() + 3600000),
  });
  tokens.set(person.id, token);
}

const stamp = Date.now().toString(36);
const alpha = await createChannel(db, { workspaceId, name: `Approvals ${stamp}`, createdBy: owner.id });
const beta = await createChannel(db, { workspaceId, name: `Second ${stamp}`, createdBy: owner.id });
/**
 * A channel the owner is deliberately NOT in, for the private-copy path.
 * Created by the colleague: `createChannel` makes its creator a member, so
 * an owner-created channel would have the owner in it.
 */
const elsewhere = await createChannel(db, { workspaceId, name: `Elsewhere ${stamp}`, createdBy: colleague.id });

const agentA = await createAgent(db, {
  workspaceId, ownerUserId: owner.id, name: 'Approval Alpha', spriteKey: 'slate',
  scopes: ['chat', 'status', 'dm'],
});
const agentB = await createAgent(db, {
  workspaceId, ownerUserId: owner.id, name: 'Approval Beta', spriteKey: 'slate',
  scopes: ['chat', 'status', 'dm'],
});
for (const channel of [alpha, beta])
  for (const member of [agentA.id, agentB.id, colleague.id])
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: member,
      memberKind: member === colleague.id ? 'human' : 'agent',
      addedBy: owner.id,
    });
// `elsewhere` holds the agent and its creator, the colleague. The owner
// stays out of it: that is the whole point of the case.
await addChannelMember(db, {
  channelId: elsewhere.id,
  memberId: agentA.id,
  memberKind: 'agent',
  addedBy: colleague.id,
});
const dm = await openDm(db, { workspaceId, openerId: owner.id, other: { id: agentA.id, kind: 'agent' } });

writeFileSync(
  output + '/seed.json',
  JSON.stringify({ workspaceId, ownerId: owner.id, token: session.token, agentA, agentB, alpha, beta, elsewhere, dm }, null, 2),
  { mode: 0o600 },
);

const rooms: Room[] = [];
const connect = async (options: object) => {
  const room = await new Client(base + '/colyseus').joinOrCreate('office', {
    mapId: 'hq', workspaceId, ...options,
  });
  room.onMessage('*', () => {});
  rooms.push(room);
  return room;
};

interface Seen {
  cards: PublicApprovalRequest[];
  resolved: PublicApprovalResolved[];
  errors: ErrorPayload[];
}
const watch = (room: Room): Seen => {
  const seen: Seen = { cards: [], resolved: [], errors: [] };
  room.onMessage(ServerMessage.Approval, (v: PublicApprovalRequest) => seen.cards.push(v));
  room.onMessage(ServerMessage.ApprovalResolved, (v: PublicApprovalResolved) => seen.resolved.push(v));
  room.onMessage(ServerMessage.Error, (v: ErrorPayload) => seen.errors.push(v));
  return seen;
};

const human = await connect({ token: session.token });
const ownerSeen = watch(human);
const colleagueRoom = await connect({ token: tokens.get(colleague.id) });
const colleagueSeen = watch(colleagueRoom);
const outsiderRoom = await connect({ token: tokens.get(outsider.id) });
const outsiderSeen = watch(outsiderRoom);

let aRoom = await connect({ agentKey: agentA.key });
const bRoom = await connect({ agentKey: agentB.key });
const decisionsA: AgentApprovalDecisionEvent[] = [];
const decisionsB: AgentApprovalDecisionEvent[] = [];
aRoom.onMessage('agent:approval_decision', (v: AgentApprovalDecisionEvent) => decisionsA.push(v));
bRoom.onMessage('agent:approval_decision', (v: AgentApprovalDecisionEvent) => decisionsB.push(v));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, label: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!test()) {
    assert.ok(Date.now() < end, label);
    await sleep(20);
  }
};

const ask = (channelId: string, toolName: string, summary: string, ms = 300_000): ApprovalRequest => ({
  version: 1,
  requestId: randomUUID(),
  turnId: randomUUID(),
  workerId: '0',
  sessionId: 'session-1',
  channelId,
  toolName,
  summary,
  options: [
    { id: 'allow_once', label: 'Allow once' },
    { id: 'deny', label: 'Deny' },
  ],
  askedAt: Date.now(),
  expiresAt: Date.now() + ms,
});

const report: Record<string, unknown> = {};
await sleep(11_000); // The running room refreshes externally seeded membership every 10s.
try {
  // 1. A card reaches the owner and the channel's other member; nobody else.
  const first = ask(alpha.id, 'Bash', 'pnpm build');
  const askedAt = Date.now();
  aRoom.send('agent:approval_request', first);
  await until(() => ownerSeen.cards.some((c) => c.requestId === first.requestId), 'card to the owner');
  report.deliveryMs = Date.now() - askedAt;
  await until(() => colleagueSeen.cards.some((c) => c.requestId === first.requestId), 'card to the member');
  await sleep(300);
  assert.equal(outsiderSeen.cards.length, 0, 'a non-member saw nothing');
  const card = ownerSeen.cards.find((c) => c.requestId === first.requestId)!;
  assert.equal(card.ownerUserId, owner.id, 'the office says who may answer');
  assert.equal(card.agentName, 'Approval Alpha');
  assert.equal(card.summary, 'pnpm build');
  assert.equal(card.private, undefined, 'the owner can read this channel');

  // 2. A member who is not the owner cannot answer it.
  colleagueRoom.send(ClientMessage.ApprovalDecide, { requestId: first.requestId, optionId: 'allow_once' });
  await until(() => colleagueSeen.errors.length > 0, 'the colleague refused');
  assert.equal(colleagueSeen.errors.at(-1)!.code, 'missing_scope');
  await sleep(200);
  assert.equal(decisionsA.length, 0, 'and nothing reached the agent');

  // 3. A crafted option the card never offered is refused server-side.
  human.send(ClientMessage.ApprovalDecide, { requestId: first.requestId, optionId: 'allow_always' });
  human.send(ClientMessage.ApprovalDecide, { requestId: randomUUID(), optionId: 'deny' });
  await until(() => ownerSeen.errors.length >= 2, 'crafted and unknown refused');
  assert.equal(decisionsA.length, 0);

  // 4. Two questions about the same tool, two agents, two channels.
  const second = ask(beta.id, 'Bash', 'rm -rf build');
  bRoom.send('agent:approval_request', second);
  await until(() => ownerSeen.cards.some((c) => c.requestId === second.requestId), 'the second card');
  human.send(ClientMessage.ApprovalDecide, { requestId: second.requestId, optionId: 'deny' });
  await until(() => decisionsB.length > 0, 'the second agent answered');
  assert.equal(decisionsB[0]!.requestId, second.requestId);
  assert.equal(decisionsB[0]!.optionId, 'deny');
  assert.equal(decisionsA.length, 0, 'the first agent was not touched');

  human.send(ClientMessage.ApprovalDecide, { requestId: first.requestId, optionId: 'allow_once' });
  await until(() => decisionsA.length > 0, 'the first agent answered');
  assert.equal(decisionsA[0]!.requestId, first.requestId);
  assert.equal(decisionsA[0]!.optionId, 'allow_once');
  assert.equal(decisionsA[0]!.decidedByUserId, owner.id);

  // 5. A second click on one already answered is refused.
  const before = ownerSeen.errors.length;
  human.send(ClientMessage.ApprovalDecide, { requestId: first.requestId, optionId: 'deny' });
  await until(() => ownerSeen.errors.length > before, 'the repeat click refused');
  assert.equal(decisionsA.length, 1, 'and it did not reach the agent twice');

  // 6. The harness's resolution takes the card down for everyone who saw it.
  aRoom.send('agent:approval_resolved', {
    version: 1, requestId: first.requestId, turnId: first.turnId,
    resolution: 'allowed', optionId: 'allow_once', via: 'card', resolvedAt: Date.now(),
  });
  await until(() => ownerSeen.resolved.some((r) => r.requestId === first.requestId), 'resolution to the owner');
  await until(() => colleagueSeen.resolved.some((r) => r.requestId === first.requestId), 'resolution to the member');
  assert.equal(outsiderSeen.resolved.length, 0);

  // 7. Asked where the owner cannot read: a private copy, and only to them.
  const hidden = ask(elsewhere.id, 'Write', '/repo/src/secret.ts');
  const colleagueCardsBefore = colleagueSeen.cards.length;
  aRoom.send('agent:approval_request', hidden);
  await until(() => ownerSeen.cards.some((c) => c.requestId === hidden.requestId), 'the private card');
  assert.equal(
    ownerSeen.cards.find((c) => c.requestId === hidden.requestId)!.private,
    true,
    'marked private: the owner is not in that channel',
  );
  await until(() => colleagueSeen.cards.length > colleagueCardsBefore, 'the member in that channel sees it too');
  assert.equal(
    colleagueSeen.cards.at(-1)!.private,
    undefined,
    'but not as a private copy — they read the channel it is in',
  );
  assert.equal(outsiderSeen.cards.length, 0, 'and still nothing to a non-member');

  // 8. A pending card is replayed to a client that asks for history.
  const late = await connect({ token: session.token });
  const lateSeen = watch(late);
  const histories: HistoryPayload[] = [];
  late.onMessage(ServerMessage.History, (v: HistoryPayload) => histories.push(v));
  late.send(ClientMessage.HistoryGet, { channelId: elsewhere.id });
  late.send(ClientMessage.HistoryGet, { channelId: alpha.id });
  await until(
    () => lateSeen.cards.some((c) => c.requestId === hidden.requestId && c.private === true),
    'a reopened panel finds the private question waiting',
  );
  assert.ok(
    !lateSeen.cards.some((c) => c.requestId === first.requestId),
    'and is not shown a dead one',
  );
  // The card reaching the owner does not open the channel it came from.
  await until(() => lateSeen.errors.length > 0, 'history for a channel we are not in is refused');
  assert.ok(
    !histories.some((page) => page.channelId === elsewhere.id),
    'no transcript from a channel the owner is not in',
  );

  // 9. A DM card: same rules, and never outside the DM.
  const inDm = ask(dm.id, 'Read', '/repo/README.md');
  aRoom.send('agent:approval_request', inDm);
  await until(() => ownerSeen.cards.some((c) => c.requestId === inDm.requestId), 'the DM card');
  await sleep(300);
  assert.ok(!colleagueSeen.cards.some((c) => c.requestId === inDm.requestId), 'a DM stays a DM');
  assert.equal(outsiderSeen.cards.length, 0);

  // 10. The agent goes: every card it held comes down, so nothing offers a
  //     button that could not possibly reach a runtime.
  await aRoom.leave(true);
  rooms.splice(rooms.indexOf(aRoom), 1);
  await until(
    () =>
      ownerSeen.resolved.some((r) => r.requestId === hidden.requestId && r.resolution === 'interrupted') &&
      ownerSeen.resolved.some((r) => r.requestId === inDm.requestId && r.resolution === 'interrupted'),
    'disconnect closed the cards',
  );

  // 11. Reconnect: the harness says the open questions again and they come back.
  aRoom = await connect({ agentKey: agentA.key });
  const resumed = ask(alpha.id, 'Bash', 'pnpm test');
  aRoom.send('agent:approval_request', resumed);
  await until(() => ownerSeen.cards.some((c) => c.requestId === resumed.requestId), 'a card after reconnect');

  // 12. A question nobody answers is taken down by the office, and denied.
  //     The harness has its own timer; this is the backstop for one that
  //     died holding a question, so a card can never wait forever.
  const doomed = ask(alpha.id, 'Bash', 'sleep 600', 1_000);
  aRoom.send('agent:approval_request', doomed);
  await until(() => ownerSeen.cards.some((c) => c.requestId === doomed.requestId), 'the short-lived card');
  await until(
    () => ownerSeen.resolved.some((r) => r.requestId === doomed.requestId && r.resolution === 'expired'),
    'the office expired it',
    60_000,
  );
  // And an answer arriving after that is refused rather than forwarded.
  const errorsBeforeLate = ownerSeen.errors.length;
  human.send(ClientMessage.ApprovalDecide, { requestId: doomed.requestId, optionId: 'allow_once' });
  await until(() => ownerSeen.errors.length > errorsBeforeLate, 'the late answer refused');

  // 13. An agent cannot put a card in a channel it is not in, nor can a human
  //     forge one.
  const forgedChannel = { ...ask('not-a-channel', 'Bash', 'whoami'), channelId: 'not-a-channel' };
  aRoom.send('agent:approval_request', forgedChannel);
  human.send('agent:approval_request', ask(alpha.id, 'Bash', 'forged by a human'));
  await sleep(400);
  assert.ok(!ownerSeen.cards.some((c) => c.requestId === forgedChannel.requestId));
  assert.ok(!ownerSeen.cards.some((c) => c.summary === 'forged by a human'));

  Object.assign(report, {
    pass: true,
    cardsToOwner: ownerSeen.cards.length,
    cardsToMember: colleagueSeen.cards.length,
    cardsToNonMember: outsiderSeen.cards.length,
    refusals: ownerSeen.errors.concat(colleagueSeen.errors).map((e) => e.code),
    decisions: { alpha: decisionsA.length, beta: decisionsB.length },
    resolutions: ownerSeen.resolved.map((r) => [r.requestId.slice(0, 6), r.resolution]),
    privateCardId: hidden.requestId.slice(0, 6),
    expiredCardId: doomed.requestId.slice(0, 6),
  });
  writeFileSync(output + '/approval-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (process.env.QUIN52_HOLD === '1') {
    console.log('Holding cards for visual verification');
    await new Promise(() => {});
  }
} finally {
  await Promise.allSettled(rooms.map((r) => r.leave(true)));
}
process.exit(0);
