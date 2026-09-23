/** QUIN-52 live-runtime probe. Drives a real ACP runtime through allow / deny
 * / expire against a running office, as the agent's owner.
 *   QUIN52_SEED=/path/seed.json pnpm exec tsx apps/server/scripts/live-approval-probe.mts
 * QUIN52_PHASE=allow|deny|expire picks one; default runs allow then deny. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { Client, type Room } from 'colyseus.js';
import {
  ClientMessage,
  ServerMessage,
  type ChannelChatPayload,
  type ErrorPayload,
  type PublicActivity,
  type PublicApprovalRequest,
  type PublicApprovalResolved,
} from '@quintal/shared';

const seed = JSON.parse(readFileSync(process.env.QUIN52_SEED!, 'utf8'));
const base = process.env.QUIN52_URL ?? 'http://127.0.0.1:3052';
const output = process.env.QUIN52_OUTPUT ?? '/tmp/quin52-verification';
const phase = process.env.QUIN52_PHASE ?? 'both';
/**
 * The probe is a file write, not a shell command.
 *
 * Claude Code's `default` ("Manual") mode asks before *making changes*; a
 * shell `echo` it considers safe and runs. So the safe probe that actually
 * exercises the approval path is a small write into the agent's own
 * disposable workspace, and whether the file exists afterwards is the honest
 * test of whether "deny" denied anything.
 */
const workspace = process.env.QUIN52_WORKSPACE ?? '/tmp/quin52-verification/workspace';
const probeFile = (name: string) => `${workspace}/${name}.txt`;
mkdirSync(output, { recursive: true });

const room: Room = await new Client(base + '/colyseus').joinOrCreate('office', {
  mapId: 'hq', workspaceId: seed.workspaceId, token: seed.token,
});
room.onMessage('*', () => {});
const cards: PublicApprovalRequest[] = [];
const resolved: PublicApprovalResolved[] = [];
const errors: ErrorPayload[] = [];
const posts: ChannelChatPayload[] = [];
const activity: PublicActivity[] = [];
room.onMessage(ServerMessage.Approval, (v: PublicApprovalRequest) => cards.push(v));
room.onMessage(ServerMessage.ApprovalResolved, (v: PublicApprovalResolved) => resolved.push(v));
room.onMessage(ServerMessage.Error, (v: ErrorPayload) => errors.push(v));
room.onMessage(ServerMessage.ChannelChat, (v: ChannelChatPayload) => posts.push(v));
room.onMessage('activity', (v: PublicActivity) => activity.push(v));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (test: () => boolean, label: string, ms = 120_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    assert.ok(Date.now() < end, label);
    await sleep(100);
  }
};
const say = (text: string) =>
  room.send(ClientMessage.ChannelChat, { channelId: seed.channelId, text });

const report: Record<string, unknown> = { phase };
await sleep(11_000); // the running room refreshes externally seeded membership every 10s

try {
  if (phase === 'allow' || phase === 'both') {
    const t0 = Date.now();
    rmSync(probeFile('allow'), { force: true });
    say(`@${seed.agentName} create a file called allow.txt in your working directory containing the word quintal-probe-allow, then tell me you did it.`);
    await until(() => cards.length > 0, 'the approval card');
    const card = cards[0]!;
    report.allow = {
      seenAfterMs: Date.now() - t0,
      tool: card.toolName,
      summary: card.summary,
      options: card.options.map((o) => o.id),
      ownerUserId: card.ownerUserId,
      turnId: card.turnId,
      windowMs: card.expiresAt - card.askedAt,
    };
    assert.deepEqual(card.options.map((o) => o.id), ['allow_once', 'deny'], 'two options, no standing grant');
    assert.equal(card.ownerUserId, seed.ownerId);

    // While it waits, the turn must read as waiting rather than as work.
    const waiting = activity.filter((a) => a.state === 'waiting');
    (report.allow as Record<string, unknown>).turnWentToWaiting = waiting.length > 0;

    room.send(ClientMessage.ApprovalDecide, { requestId: card.requestId, optionId: 'allow_once' });
    await until(
      () => resolved.some((r) => r.requestId === card.requestId),
      'the harness to say how it ended',
    );
    const outcome = resolved.find((r) => r.requestId === card.requestId)!;
    (report.allow as Record<string, unknown>).resolution = [outcome.resolution, outcome.via];
    assert.equal(outcome.resolution, 'allowed');

    // The turn continues: the runtime does the work and answers. The file on
    // disk is the part that cannot be faked by a polite reply.
    await until(() => existsSync(probeFile('allow')), 'the tool to actually run after allowing', 180_000);
    await until(() => posts.length > 1, 'the reply after allowing', 180_000);
    Object.assign(report.allow as Record<string, unknown>, {
      fileWritten: readFileSync(probeFile('allow'), 'utf8').trim(),
      reply: posts.slice(1).map((p) => p.text.slice(0, 200)),
      continuedAfterMs: Date.now() - t0,
    });
  }

  if (phase === 'deny' || phase === 'both') {
    const before = cards.length;
    const postsBefore = posts.length;
    const t0 = Date.now();
    rmSync(probeFile('deny'), { force: true });
    say(`@${seed.agentName} create a file called deny.txt in your working directory containing the word quintal-probe-deny, then tell me you did it.`);
    await until(() => cards.length > before, 'the second card');
    const card = cards.at(-1)!;
    assert.notEqual(card.requestId, cards[before - 1]?.requestId, 'a new question, a new identity');
    room.send(ClientMessage.ApprovalDecide, { requestId: card.requestId, optionId: 'deny' });
    await until(() => resolved.some((r) => r.requestId === card.requestId), 'the denial to land');
    const outcome = resolved.find((r) => r.requestId === card.requestId)!;
    assert.equal(outcome.resolution, 'denied');
    await until(() => posts.length > postsBefore, 'the agent to say something after being denied', 180_000);
    await sleep(2_000);
    report.deny = {
      seenAfterMs: Date.now() - t0,
      requestId: card.requestId.slice(0, 6),
      tool: card.toolName,
      summary: card.summary,
      resolution: [outcome.resolution, outcome.via],
      reply: posts.slice(postsBefore).map((p) => p.text.slice(0, 300)),
      fileWritten: existsSync(probeFile('deny')),
    };
    assert.equal(existsSync(probeFile('deny')), false, 'a denied tool must not have run');
  }

  if (phase === 'expire' || phase === 'both') {
    const before = cards.length;
    const t0 = Date.now();
    rmSync(probeFile('expire'), { force: true });
    say(`@${seed.agentName} create a file called expire.txt in your working directory containing the word quintal-probe-expire, then tell me you did it.`);
    await until(() => cards.length > before, 'the third card');
    const card = cards.at(-1)!;
    // Answer nothing at all. Five minutes of silence is a no.
    await until(
      () => resolved.some((r) => r.requestId === card.requestId),
      'the question to time out',
      420_000,
    );
    const outcome = resolved.find((r) => r.requestId === card.requestId)!;
    report.expire = {
      requestId: card.requestId.slice(0, 6),
      waitedMs: Date.now() - t0,
      resolution: [outcome.resolution, outcome.via],
    };
    assert.ok(['expired'].includes(outcome.resolution), `silence denies: got ${outcome.resolution}`);
    await sleep(2_000);
    (report.expire as Record<string, unknown>).fileWritten = existsSync(probeFile('expire'));
    assert.equal(existsSync(probeFile('expire')), false, 'an unanswered tool must not have run');
  }

  report.pass = true;
  report.cardsSeen = cards.length;
  writeFileSync(`${output}/live-probe-${phase}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.pass = false;
  report.error = String(error);
  report.cards = cards.map((c) => ({ id: c.requestId.slice(0, 6), tool: c.toolName, summary: c.summary }));
  report.posts = posts.map((p) => p.text.slice(0, 200));
  writeFileSync(`${output}/live-probe-${phase}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await room.leave(true);
  process.exit(1);
}
await room.leave(true);
process.exit(0);
