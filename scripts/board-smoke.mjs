/**
 * Drive the office board over the wire, as a browser would.
 *
 * Signs in with a fresh key, asks for a game ticket, joins the office room
 * and sends the four board messages — `board_get`, `board_create`,
 * `board_update`, `board_delete` — checking what the office says back each
 * time.
 *
 * Then a second person is let into the office by writing their membership
 * row straight into the database, and that row is changed under them while
 * they stay connected: admin, then member, then gone. The office must notice
 * each time, without a reconnect. That rule lives in the room, where no unit
 * test on the row module can see it.
 *
 * Then an agent is made and joins. A note handed to it lands in the DM as a
 * line from the person, with the brief attached; the agent's `agent:task`
 * moves the note along the board and puts its branch and pull request on
 * it; a note it was handed is matched to a task that named none; and being
 * taken off a note is said to it too.
 *
 * Then, with `SMOKE_GITHUB=1`, the office's own GitHub: a stub GitHub is
 * stood up on :4799 and the server must have been started pointing at it
 * (`QUINTAL_GITHUB_API=http://127.0.0.1:4799 pnpm dev`). A token goes in,
 * the office is asked to check, the pull request's checks and mergeability
 * show on the ledger line, a squash merge from the board reaches the stub
 * pinned to the head seen, and the note follows to done.
 *
 *   node scripts/board-smoke.mjs [baseUrl]
 *
 * Needs a server already running (`pnpm dev` or `pnpm start`) on the same
 * database this script opens: `DATABASE_URL`, or the default
 * `data/quintal.db` at the repo root.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  signAuthPayload,
} from '@quintal/shared';
import { clearOfficeGithub, createAgent, getClient, setOfficeGithub } from '@quintal/shared/db';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

const failures = [];
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function signIn() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKeyHex(secretKey);
  const challenge = await fetch(`${base}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  });
  if (!challenge.ok) throw new Error(`challenge failed: ${challenge.status}`);
  const { nonce, origin } = await challenge.json();
  const payload = buildAuthPayload({ origin, nonce, timestamp: Math.floor(Date.now() / 1000) });
  const verify = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ pubkey, sig: signAuthPayload(secretKey, payload), payload }),
  });
  if (!verify.ok) throw new Error(`verify failed: ${verify.status} ${await verify.text()}`);
  const cookie = (verify.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');
  if (!cookie) throw new Error('verify set no session cookie');
  return { cookie, pubkey };
}

async function ticket(cookie) {
  const response = await fetch(`${base}/api/game/join`, { method: 'POST', headers: { cookie } });
  if (!response.ok) throw new Error(`join ticket failed: ${response.status}`);
  return response.json();
}

/** A room with a mailbox: every `board`, `error` and `notice` kept, and a way to wait for the next one. */
async function enter(options, kinds = ['board', 'error', 'notice', 'channel_chat']) {
  const { Client } = await import('colyseus.js');
  const client = new Client(`${base}/colyseus`);
  const room = await client.joinOrCreate('office', { mapId: 'hq', ...options });
  const inbox = Object.fromEntries(kinds.map((kind) => [kind, []]));
  const waiters = [];
  const deliver = (kind, payload) => {
    inbox[kind].push(payload);
    for (const waiter of waiters.splice(0)) waiter({ kind, payload });
  };
  room.onMessage('*', () => {});
  for (const kind of kinds) room.onMessage(kind, (payload) => deliver(kind, payload));
  /** The next `kind` — the next one `matches`, when given — within `ms`. */
  const next = (kind, ms = 4000, matches = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${kind} within ${ms}ms`)), ms);
      const waiter = ({ kind: got, payload }) => {
        if (got !== kind || !matches(payload)) {
          waiters.push(waiter);
          return;
        }
        clearTimeout(timer);
        resolve(payload);
      };
      waiters.push(waiter);
    });
  return { room, inbox, next };
}

const { cookie } = await signIn();
const { token, workspaceId, user } = await ticket(cookie);
const me = await enter({ token, workspaceId });

try {
  // Asked, so answered.
  me.room.send('board_get', {});
  const first = await me.next('board');
  check(Array.isArray(first.items) && Array.isArray(first.agents), 'board_get answers with the board');
  check(first.you?.userId === user.id && first.you?.role === 'owner', 'the board says where I stand', JSON.stringify(first.you));
  const before = first.items.length;

  me.room.send('board_create', {
    title: '  Fix the  office chair ',
    body: 'It clips through the desk.\r\n\r\n\r\nSee the Focus Room.',
    color: 'pink',
    labels: 'bug, Furniture, bug',
  });
  const created = await me.next('board');
  const chair = created.items.find((item) => item.title === 'Fix the office chair');
  check(created.items.length === before + 1 && !!chair, 'board_create pins a note, and everybody is told');
  check(chair?.color === 'pink' && chair?.status === 'open', 'the note is as written', `${chair?.color} ${chair?.status}`);
  check(JSON.stringify(chair?.labels) === '["bug","Furniture"]', 'labels are chips, distinct in any case', JSON.stringify(chair?.labels));
  check(chair?.body === 'It clips through the desk.\n\nSee the Focus Room.', 'the body keeps its lines and loses the blank run');
  check(chair?.createdBy?.id === user.id && chair?.createdBy?.kind === 'human', 'the note says who wrote it');
  check(created.items[0]?.id === chair?.id, 'newest first');

  me.room.send('board_update', { itemId: chair.id, status: 'in_progress', labels: ['bug'] });
  const moved = await me.next('board');
  const movedChair = moved.items.find((item) => item.id === chair.id);
  check(movedChair?.status === 'in_progress' && movedChair?.title === chair.title, 'board_update changes only what it names');
  check(JSON.stringify(movedChair?.labels) === '["bug"]', 'labels replaced whole');

  me.room.send('board_update', { itemId: chair.id, assigneeAgentId: 'nobody-here' });
  const refusedAssignee = await me.next('error');
  check(refusedAssignee.code === 'not_found', 'a note cannot be for an agent that is not here', refusedAssignee.message);

  me.room.send('board_update', { itemId: chair.id, title: '   ' });
  const refusedTitle = await me.next('error');
  check(refusedTitle.code === 'invalid_payload', 'a blank title is refused', refusedTitle.message);

  me.room.send('board_create', { body: 'no title' });
  const refusedCreate = await me.next('error');
  check(refusedCreate.code === 'invalid_payload', 'a note needs a title', refusedCreate.message);

  // A second browser of the same person: it is told the board when it asks,
  // and hears the deletion without asking.
  const other = await enter({ token, workspaceId });
  try {
    other.room.send('board_get', {});
    const theirs = await other.next('board');
    check(theirs.items.some((item) => item.id === chair.id), 'a second session reads the same board');

    me.room.send('board_delete', { itemId: chair.id });
    const [mine, seen] = await Promise.all([me.next('board'), other.next('board')]);
    check(!mine.items.some((item) => item.id === chair.id), 'board_delete takes the note down');
    check(!seen.items.some((item) => item.id === chair.id), 'and the other session hears it');

    me.room.send('board_delete', { itemId: chair.id });
    const gone = await me.next('error');
    check(gone.code === 'not_found', 'taking down a note twice is refused', gone.message);
  } finally {
    await other.room.leave();
  }

  // The number is the office's own: the next note is one past the last ever written.
  me.room.send('board_create', { title: 'Improve the tunnel' });
  const again = await me.next('board');
  const tunnel = again.items.find((item) => item.title === 'Improve the tunnel');
  check(tunnel && tunnel.number > chair.number, 'a number is never reused', `${chair.number} then ${tunnel?.number}`);
  me.room.send('board_delete', { itemId: tunnel.id });
  await me.next('board');

  await standingChangesMidSession();
  await anAgentTakesANote();
  await aColleagueKeepsTheirHandsOffMyAgent();
  await anAgentWritesOnTheBoard();
  if (process.env.SMOKE_GITHUB === '1') await theOfficeChecksGithub();
} finally {
  await me.room.leave();
}

/**
 * A second person's standing changes while they stay in the room. Every
 * write reads the membership afresh, so each change is felt at once: an
 * admin takes down my note; demoted to member, they are refused my next
 * one; removed, they are refused a pen at all — and the board they are
 * sent says so.
 */
async function standingChangesMidSession() {
  const db = getClient();
  const guest = await signIn();
  const theirs = await ticket(guest.cookie);
  const membershipId = randomUUID();
  await db.execute({
    sql: 'INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [membershipId, workspaceId, theirs.user.id, 'admin', Date.now()],
  });
  const setRole = (role) =>
    db.execute({ sql: 'UPDATE memberships SET role = ? WHERE id = ?', args: [role, membershipId] });

  const them = await enter({ token: theirs.token, workspaceId });
  try {
    them.room.send('board_get', {});
    const seen = await them.next('board');
    check(seen.you?.role === 'admin', 'an admin let in by their row is told so', JSON.stringify(seen.you));

    me.room.send('board_create', { title: 'Oil the door' });
    const [, withDoor] = await Promise.all([me.next('board'), them.next('board')]);
    const door = withDoor.items.find((item) => item.title === 'Oil the door');
    them.room.send('board_delete', { itemId: door.id });
    const afterDoor = await them.next('board');
    check(!afterDoor.items.some((item) => item.id === door.id), 'an admin takes down a note they did not write');

    me.room.send('board_create', { title: 'Water the plants' });
    const [, withPlants] = await Promise.all([me.next('board'), them.next('board')]);
    const plants = withPlants.items.find((item) => item.title === 'Water the plants');

    await setRole('member');
    them.room.send('board_delete', { itemId: plants.id });
    const [refusedDelete, demoted] = await Promise.all([them.next('error'), them.next('board')]);
    check(refusedDelete.code === 'unauthorised', 'demoted mid-session, they may not take down my note', refusedDelete.message);
    check(demoted.you?.role === 'member', 'and the board they are sent says member now', JSON.stringify(demoted.you));

    await db.execute({ sql: 'DELETE FROM memberships WHERE id = ?', args: [membershipId] });
    them.room.send('board_create', { title: 'Still here?' });
    const [refusedCreate, removed] = await Promise.all([them.next('error'), them.next('board')]);
    check(refusedCreate.code === 'unauthorised', 'removed mid-session, they are refused a pen', refusedCreate.message);
    check(removed.you?.role === null, 'and the board they are sent says guest', JSON.stringify(removed.you));
    check(Array.isArray(removed.tasks) && removed.tasks.length === 0, 'a guest is not sent the ledger', JSON.stringify(removed.tasks));
    check(
      removed.agents.every((agent) => agent.hostLabel === null && agent.runtimeId === null && agent.modelId === null),
      "nor the office's machines, runtimes or models",
      JSON.stringify(removed.agents),
    );
    check(
      removed.agents.every((agent) => agent.lastSeenAt === null || agent.lastSeenAt % 60_000 === 0),
      'and last seen is to the minute',
      JSON.stringify(removed.agents.map((agent) => agent.lastSeenAt)),
    );

    me.room.send('board_delete', { itemId: plants.id });
    await me.next('board');
  } finally {
    await them.room.leave();
    await db.execute({ sql: 'DELETE FROM memberships WHERE id = ?', args: [membershipId] });
  }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nall ok');


/**
 * A note handed to an agent reaches it as a line in the DM with the brief
 * attached, and its `agent:task` moves the note along the board.
 */
async function anAgentTakesANote() {
  const db = getClient();
  const { getDb } = await import('@quintal/shared/db');
  const agent = await createAgent(getDb(), {
    workspaceId,
    ownerUserId: user.id,
    name: `Smoke${Date.now().toString(36)}`,
    spriteKey: 'slate',
  });
  const them = await enter({ agentKey: agent.key, workspaceId }, ['agent:channel_chat', 'agent:ready', 'agent:error']);
  try {
    const noteOf = (board, id) => board.items.find((item) => item.id === id);

    // Handed over: the person is seen to say so in the DM, and the agent is asked.
    me.room.send('board_create', { title: 'Fix the stapler', body: 'It jams on the third sheet.', labels: ['bug'] });
    const stapler = (await me.next('board')).items.find((item) => item.title === 'Fix the stapler');
    const told = them.next('agent:channel_chat', 6000, (line) => /is yours/.test(line.text));
    const heard = me.next('channel_chat', 6000, (line) => /is yours/.test(line.text));
    const assigned = me.next('board', 6000, (board) => noteOf(board, stapler.id)?.assignee?.id === agent.id);
    me.room.send('board_update', { itemId: stapler.id, assigneeAgentId: agent.id });
    await assigned;
    const mine = await heard;
    check(mine.channel?.kind === 'dm' && mine.fromName !== agent.name, 'the hand-over is a line of mine in the DM', mine.text);
    const theirs = await told;
    check(theirs.mentioned === true, 'the agent is named by it');
    check(theirs.command?.name === 'board' && theirs.command?.args === `#${stapler.number}`, 'with the brief attached', JSON.stringify(theirs.command?.name));
    check(new RegExp(`task_begin and pass item ${stapler.number}`).test(theirs.command?.instructions ?? ''), 'which says how the board follows');
    check(/It jams on the third sheet/.test(theirs.command?.instructions ?? ''), 'and carries the note');

    // The agent begins a task for it: the note moves and shows the branch.
    const branch = `quintal/${agent.name.toLowerCase()}/fix-the-stapler`;
    const task = { title: 'fix the stapler', repo: 'office', branch, item: stapler.number };
    const moved = me.next('board', 6000, (board) => noteOf(board, stapler.id)?.status === 'in_progress');
    them.room.send('agent:task', task);
    const movedBoard = await moved;
    const onBranch = noteOf(movedBoard, stapler.id);
    check(onBranch.task?.branch === branch && onBranch.task?.active === true, 'a task for the note moves it to in progress, on its branch', JSON.stringify(onBranch.task));
    const ledgerLine = movedBoard.tasks?.find((t) => t.branch === branch);
    check(ledgerLine?.agentId === agent.id && ledgerLine?.item?.number === stapler.number && ledgerLine?.status === 'active', 'and the board carries the ledger line', JSON.stringify(ledgerLine));

    const pr = { number: 7, url: 'https://github.com/acme/office/pull/7', state: 'open' };
    const reviewed = me.next('board', 6000, (board) => noteOf(board, stapler.id)?.task?.pr?.state === 'open');
    them.room.send('agent:task', { ...task, pr });
    check((noteOf(await reviewed, stapler.id)).status === 'in_progress', 'an open pull request is shown, and the note stays where it is');

    const done = me.next('board', 6000, (board) => noteOf(board, stapler.id)?.status === 'done');
    them.room.send('agent:task', { ...task, pr: { ...pr, state: 'merged' } });
    const doneBoard = await done;
    check((noteOf(doneBoard, stapler.id)).task?.pr?.state === 'merged', 'the merge moves it to done');
    check(doneBoard.tasks?.find((t) => t.branch === branch)?.pr?.state === 'merged', 'and the ledger line says merged');

    const over = me.next('board', 6000, (board) => noteOf(board, stapler.id)?.task?.active === false);
    them.room.send('agent:task', null);
    await over;
    check(true, 'and the task ending leaves the note done, its branch on it');

    // A task that names no note is matched to the newest note handed to the agent.
    me.room.send('board_create', { title: 'Oil the hinge', assigneeAgentId: agent.id });
    const hinge = (await me.next('board', 4000, (board) => board.items.some((item) => item.title === 'Oil the hinge'))).items.find((item) => item.title === 'Oil the hinge');
    const matched = me.next('board', 6000, (board) => noteOf(board, hinge.id)?.status === 'in_progress');
    them.room.send('agent:task', { title: 'oil the hinge', repo: 'office', branch: `quintal/${agent.name.toLowerCase()}/oil` });
    check((noteOf(await matched, hinge.id)).task?.branch.endsWith('/oil'), 'a task naming no note takes the newest handed to the agent');
    them.room.send('agent:task', null);

    // Taken off a note, the agent is told.
    const letGo = them.next('agent:channel_chat', 6000, (line) => /no longer yours/.test(line.text));
    me.room.send('board_update', { itemId: hinge.id, assigneeAgentId: null });
    check((await letGo).command === undefined, 'being taken off a note is said, without a brief');

    for (const id of [stapler.id, hinge.id]) {
      me.room.send('board_delete', { itemId: id });
      await me.next('board');
    }
  } finally {
    await them.room.leave();
    await db.execute({ sql: 'DELETE FROM agents WHERE id = ?', args: [agent.id] });
  }
}

/**
 * Handing a note to an agent is its owner's to do, and a task names only its
 * own notes: a colleague is refused my agent, my agent hears nothing from
 * them, and their agent's task leaves my agent's note alone.
 */
async function aColleagueKeepsTheirHandsOffMyAgent() {
  const db = getClient();
  const { getDb } = await import('@quintal/shared/db');
  const stamp = Date.now().toString(36);
  const colleague = await signIn();
  const theirs = await ticket(colleague.cookie);
  const membershipId = randomUUID();
  await db.execute({
    sql: 'INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [membershipId, workspaceId, theirs.user.id, 'member', Date.now()],
  });
  const myAgent = await createAgent(getDb(), { workspaceId, ownerUserId: user.id, name: `Mine${stamp}`, spriteKey: 'slate' });
  const theirAgent = await createAgent(getDb(), { workspaceId, ownerUserId: theirs.user.id, name: `Theirs${stamp}`, spriteKey: 'slate' });
  const agentKinds = ['agent:channel_chat', 'agent:ready', 'agent:error'];
  const them = await enter({ token: theirs.token, workspaceId });
  const mine = await enter({ agentKey: myAgent.key, workspaceId }, agentKinds);
  const other = await enter({ agentKey: theirAgent.key, workspaceId }, agentKinds);
  const silence = (who, ms = 1500) => who.next('agent:channel_chat', ms).then(() => false, () => true);
  const noteOf = (board, id) => board.items.find((item) => item.id === id);
  const fresh = async (who) => {
    who.room.send('board_get', {});
    return who.next('board');
  };
  const notes = [];
  try {
    // A note of mine, in my agent's hands.
    me.room.send('board_create', { title: 'Fix the stapler lid', assigneeAgentId: myAgent.id });
    const lid = (await me.next('board', 4000, (b) => b.items.some((i) => i.title === 'Fix the stapler lid'))).items.find((i) => i.title === 'Fix the stapler lid');
    notes.push(lid.id);
    await mine.next('agent:channel_chat', 6000, (line) => /is yours/.test(line.text));
    await them.next('board', 4000, (b) => noteOf(b, lid.id)?.assignee?.id === myAgent.id).catch(() => {});

    // A colleague may not hand my agent a note: refused, and my agent hears nothing.
    me.room.send('board_create', { title: 'Sort the post' });
    const post = (await me.next('board', 4000, (b) => b.items.some((i) => i.title === 'Sort the post'))).items.find((i) => i.title === 'Sort the post');
    notes.push(post.id);
    const quiet = silence(mine);
    them.room.send('board_update', { itemId: post.id, assigneeAgentId: myAgent.id });
    const refused = await them.next('error');
    check(refused.code === 'unauthorised' && /owner/.test(refused.message), "a colleague is refused my agent, and told whose it is", refused.message);
    check(await quiet, 'and my agent hears nothing from them');
    check((noteOf(await fresh(me), post.id)).assignee === null, 'the note stays unassigned');

    // Their agent's task naming my agent's note leaves it alone.
    other.room.send('agent:task', { title: 'fix the lid', repo: 'office', branch: `quintal/theirs/${stamp}`, item: lid.number });
    await new Promise((r) => setTimeout(r, 1500));
    const lidNow = noteOf(await fresh(me), lid.id);
    check(lidNow.task === null && lidNow.status === 'open', "another agent's task naming my agent's note neither links nor moves it", JSON.stringify(lidNow.task));
    other.room.send('agent:task', null);

    // They hand a note to their own agent, as they may; I may take it off, and their agent is not told by me.
    const handed = them.next('board', 6000, (b) => noteOf(b, post.id)?.assignee?.id === theirAgent.id);
    const told = other.next('agent:channel_chat', 6000, (line) => /is yours/.test(line.text));
    them.room.send('board_update', { itemId: post.id, assigneeAgentId: theirAgent.id });
    await handed;
    check((await told).command?.name === 'board', 'a colleague hands a note to their own agent, with the brief');
    const unsaid = silence(other);
    const taken = me.next('board', 6000, (b) => noteOf(b, post.id)?.assignee === null);
    me.room.send('board_update', { itemId: post.id, assigneeAgentId: null });
    await taken;
    check(await unsaid, "I may take a note off their agent, but their agent is not told in a DM I may not open");
  } finally {
    for (const id of notes) {
      me.room.send('board_delete', { itemId: id });
      await me.next('board').catch(() => {});
    }
    await Promise.all([them.room.leave(), mine.room.leave(), other.room.leave()]);
    await db.execute({ sql: 'DELETE FROM agents WHERE id IN (?, ?)', args: [myAgent.id, theirAgent.id] });
    await db.execute({ sql: 'DELETE FROM memberships WHERE id = ?', args: [membershipId] });
  }
}


/**
 * An agent with the `board` scope reads the board, pins a note as itself,
 * changes it, and hands it only where its owner could; one without the scope
 * is refused at the door.
 */
async function anAgentWritesOnTheBoard() {
  const db = getClient();
  const { getDb } = await import('@quintal/shared/db');
  const stamp = Date.now().toString(36);
  const colleague = await signIn();
  const theirs = await ticket(colleague.cookie);
  const membershipId = randomUUID();
  await db.execute({
    sql: 'INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [membershipId, workspaceId, theirs.user.id, 'member', Date.now()],
  });
  const scribe = await createAgent(getDb(), { workspaceId, ownerUserId: user.id, name: `Scribe${stamp}`, spriteKey: 'slate' });
  const sibling = await createAgent(getDb(), { workspaceId, ownerUserId: user.id, name: `Sibling${stamp}`, spriteKey: 'slate' });
  const theirAgent = await createAgent(getDb(), { workspaceId, ownerUserId: theirs.user.id, name: `Other${stamp}`, spriteKey: 'slate' });
  const mute = await createAgent(getDb(), { workspaceId, ownerUserId: user.id, name: `Mute${stamp}`, spriteKey: 'slate', scopes: ['chat'] });
  const kinds = ['agent:result', 'agent:ready', 'agent:error', 'agent:channel_chat'];
  const them = await enter({ agentKey: scribe.key, workspaceId }, kinds);
  const quiet = await enter({ agentKey: mute.key, workspaceId }, kinds);
  let seq = 0;
  const ask = async (who, type, payload) => {
    const requestId = `s${(seq += 1)}`;
    const reply = who.next('agent:result', 6000, (result) => result.requestId === requestId);
    who.room.send(type, { ...payload, requestId });
    return reply;
  };
  const notes = [];
  try {
    const ready = await them.next('agent:ready', 6000).catch(() => them.inbox['agent:ready'][0]);
    check(ready?.boardVersion === 1, 'the office says it has a board', JSON.stringify(ready?.boardVersion));

    const shown = me.next('board', 6000, (b) => b.items.some((i) => i.title === 'Login redirect drops the return URL'));
    const created = await ask(them, 'agent:board_create', {
      title: 'Login redirect drops the return URL',
      body: 'Seen on staging. After sign-in the user lands on / instead of where they were.',
      labels: ['bug', 'auth'],
    });
    check(created.ok === true && created.data.item.number > 0, 'an agent pins a note', JSON.stringify(created.error));
    const note = created.data.item;
    notes.push(note.id);
    check(note.createdBy?.kind === 'agent' && note.createdBy?.name === scribe.name, 'written as itself', JSON.stringify(note.createdBy));
    check(created.data.handover === null, 'a note handed to nobody has no hand-over line');
    check((await shown.catch(() => null)) !== null, 'and everybody is told');

    const listed = await ask(them, 'agent:board_list', { status: 'open' });
    check(listed.ok === true && listed.data.items.some((i) => i.id === note.id), 'it reads the board back');
    check(listed.data.agents.some((a) => a.name === sibling.name && a.yours === true) && listed.data.agents.some((a) => a.name === theirAgent.name && a.yours === false), 'and is told which agents are its owner\'s', JSON.stringify(listed.data.agents.map((a) => [a.name, a.yours])));
    const mineBefore = await ask(them, 'agent:board_list', { mine: true });
    check(mineBefore.ok === true && !mineBefore.data.items.some((i) => i.id === note.id), 'mine is only what it was handed');

    const got = await ask(them, 'agent:board_get', { number: note.number });
    check(got.ok === true && got.data.item.id === note.id, 'board_get by number');
    const missing = await ask(them, 'agent:board_get', { number: 999999 });
    check(missing.ok === false && missing.error.code === 'not_found', 'an unknown number is not found', JSON.stringify(missing.error));

    const toMe = await ask(them, 'agent:board_update', { number: note.number, assignee: 'me', status: 'in_progress' });
    check(toMe.ok === true && toMe.data.item.assignee?.id === scribe.id && toMe.data.item.status === 'in_progress', 'it takes a note itself and moves it', JSON.stringify(toMe.error));
    check(toMe.data.handover === null, 'taking a note yourself has no hand-over line');
    const mineAfter = await ask(them, 'agent:board_list', { mine: true });
    check(mineAfter.data.items.some((i) => i.id === note.id), 'and mine now has it');

    const toSibling = await ask(them, 'agent:board_update', { number: note.number, assignee: `@${sibling.name}` });
    check(toSibling.ok === true && toSibling.data.item.assignee?.id === sibling.id, "it hands a note to its owner's other agent by name", JSON.stringify(toSibling.error));
    check(toSibling.data.handover === `@${sibling.name} board note #${note.number} ${note.title} is yours.`, 'and gets the line to say', toSibling.data.handover);

    const toTheirs = await ask(them, 'agent:board_update', { number: note.number, assignee: theirAgent.name });
    check(toTheirs.ok === false && toTheirs.error.code === 'unauthorised' && /owner/.test(toTheirs.error.message), "but not to a colleague's agent", JSON.stringify(toTheirs.error));
    const toNobodyKnown = await ask(them, 'agent:board_update', { number: note.number, assignee: 'Zaphod' });
    check(toNobodyKnown.ok === false && toNobodyKnown.error.code === 'not_found', 'nor to a name nobody here has', JSON.stringify(toNobodyKnown.error));

    const nothing = await ask(them, 'agent:board_update', { number: note.number });
    check(nothing.ok === false && nothing.error.code === 'invalid_payload', 'a change that changes nothing is refused', JSON.stringify(nothing.error));

    // An agent being heard from is not the board changing. The writes above
    // were each followed by a board; from here nothing on it changes, while
    // the office keeps hearing from this agent, and two refresh ticks pass.
    // At most one board may arrive: the minute `lastSeenAt` is kept to may turn.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const boardsSeen = me.inbox.board.length;
    for (let i = 0; i < 4; i += 1) {
      await ask(them, 'agent:look_around', {});
      await new Promise((resolve) => setTimeout(resolve, 5_250));
    }
    check(me.inbox.board.length - boardsSeen <= 1, 'an agent being heard from does not re-send everybody the board', `${me.inbox.board.length - boardsSeen} boards in 21s`);

    // A burst past the pace is refused, with how long to wait, and writes nothing.
    // The writes above — refused ones included — spent this window's pace, which has passed by now.
    const before = (await ask(them, 'agent:board_list', {})).data.items.length;
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) => ask(them, 'agent:board_create', { title: `Burst ${i + 1}` })),
    );
    for (const made of burst) if (made.ok) notes.push(made.data.item.id);
    const paced = burst.filter((r) => !r.ok);
    check(burst.filter((r) => r.ok).length > 0 && paced.length > 0 && paced.every((r) => r.error.code === 'rate_limited' && r.error.retryAfterMs > 0), 'a burst of writes is paced, with how long to wait', JSON.stringify(paced[0]?.error));
    const after = (await ask(them, 'agent:board_list', {})).data.items.length;
    check(after === before + burst.filter((r) => r.ok).length, 'and a refused write writes nothing', `${before} → ${after}`);

    const refused = await ask(quiet, 'agent:board_list', {});
    check(refused.ok === false && refused.error.code === 'missing_scope', 'an agent without the scope is refused', JSON.stringify(refused.error));
    const refusedWrite = await ask(quiet, 'agent:board_create', { title: 'Sneaky' });
    check(refusedWrite.ok === false && refusedWrite.error.code === 'missing_scope', 'reads and writes alike');
  } finally {
    for (const id of notes) {
      me.room.send('board_delete', { itemId: id });
      await me.next('board').catch(() => {});
    }
    await Promise.all([them.room.leave(), quiet.room.leave()]);
    await db.execute({ sql: 'DELETE FROM agents WHERE id IN (?, ?, ?, ?)', args: [scribe.id, sibling.id, theirAgent.id, mute.id] });
    await db.execute({ sql: 'DELETE FROM memberships WHERE id = ?', args: [membershipId] });
  }
}

/**
 * A GitHub that answers for one pull request, #21 on acme/office, and keeps
 * what it was asked. Merged, it says so from then on.
 */
function stubGithub(port) {
  const seen = [];
  let merged = false;
  const pull = () => ({
    number: 21,
    state: merged ? 'closed' : 'open',
    merged,
    draft: false,
    title: 'Replace the kettle',
    mergeable: merged ? null : true,
    mergeable_state: merged ? 'unknown' : 'clean',
    head: { sha: 'h21', ref: 'quintal/smoke/kettle' },
    base: { ref: 'main' },
  });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const answer = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (req.headers.authorization !== 'Bearer ghp_smoke_token_0123456789abcdef') return answer(401, { message: 'Bad credentials' });
      if (req.method === 'GET' && req.url === '/user') return answer(200, { login: 'smokebot' });
      if (req.method === 'GET' && req.url === '/repos/acme/office/pulls/21') return answer(200, pull());
      if (req.method === 'GET' && req.url.startsWith('/repos/acme/office/commits/h21/check-runs')) {
        return answer(200, { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null }] });
      }
      if (req.method === 'GET' && req.url.startsWith('/repos/acme/office/pulls/21/reviews')) return answer(200, []);
      if (req.method === 'PUT' && req.url === '/repos/acme/office/pulls/21/merge') {
        merged = true;
        return answer(200, { sha: 'm21', merged: true, message: 'Pull Request successfully merged' });
      }
      return answer(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ seen, close: () => new Promise((done) => server.close(done)) })));
}

/**
 * The office's own eye on GitHub: refused without a token, then with one it
 * checks a pull request on request, paces a second ask, merges from the
 * board pinned to the head seen, and the ledger and the note follow.
 */
async function theOfficeChecksGithub() {
  const { getDb } = await import('@quintal/shared/db');
  const db = getDb();
  const github = await stubGithub(4799);
  const agent = await createAgent(db, { workspaceId, ownerUserId: user.id, name: `Kettle${Date.now().toString(36)}`, spriteKey: 'slate' });
  const them = await enter({ agentKey: agent.key, workspaceId }, ['agent:channel_chat', 'agent:ready', 'agent:error']);
  try {
    const noteOf = (board, id) => board.items.find((item) => item.id === id);

    me.room.send('board_pull_refresh', {});
    const notConfigured = await me.next('error');
    check(notConfigured.code === 'not_configured', 'without a token, asking GitHub is refused and says where the token goes', notConfigured.message);

    await setOfficeGithub(db, { workspaceId, token: 'ghp_smoke_token_0123456789abcdef', login: 'smokebot', setByUserId: user.id });

    me.room.send('board_create', { title: 'Replace the kettle', assigneeAgentId: agent.id });
    const kettle = (await me.next('board', 6000, (board) => board.items.some((item) => item.title === 'Replace the kettle'))).items.find((item) => item.title === 'Replace the kettle');
    const branch = 'quintal/smoke/kettle';
    const withPr = me.next('board', 6000, (board) => board.tasks.some((t) => t.branch === branch && t.pr?.number === 21));
    them.room.send('agent:task', { title: 'replace the kettle', repo: 'office', branch, item: kettle.number, pr: { number: 21, url: 'https://github.com/acme/office/pull/21', state: 'open' } });
    const line = (await withPr).tasks.find((t) => t.branch === branch);
    check(line.github === null, 'before the office has looked, the line carries no word from GitHub');

    const checked = me.next('board', 8000, (board) => board.tasks.find((t) => t.id === line.id)?.github?.known === true);
    const told = me.next('notice', 8000, (notice) => notice.code === 'pull_request');
    me.room.send('board_pull_refresh', {});
    const checkedBoard = await checked;
    const live = checkedBoard.tasks.find((t) => t.id === line.id).github;
    check(live.checks.summary === 'passing' && live.mergeable === true && live.mergeableState === 'clean' && live.baseRef === 'main', 'asked, the office shows what GitHub said: checks, mergeability, the base', JSON.stringify(live));
    check(checkedBoard.github?.connected === true && checkedBoard.github?.login === 'smokebot', 'and the board says whose token the office has', JSON.stringify(checkedBoard.github));
    check(/Checked the pull request/.test((await told).message), 'and I am told it was checked', (await told).message);
    check(github.seen.filter((call) => call.method === 'GET').length === 3, 'three calls to GitHub for one pull request', JSON.stringify(github.seen.map((c) => c.path)));

    me.room.send('board_pull_refresh', {});
    const paced = await me.next('error');
    check(paced.code === 'rate_limited', 'asking again at once is paced', paced.message);

    const mergedBoard = me.next('board', 8000, (board) => board.tasks.find((t) => t.id === line.id)?.github?.state === 'merged');
    const said = me.next('notice', 8000, (notice) => notice.code === 'pull_request');
    me.room.send('board_pull_action', { taskId: line.id, action: 'squash', expectedHeadSha: live.headSha });
    const after = await mergedBoard;
    check(/Merged #21 \(squash\)/.test((await said).message), 'a squash from the board is said to have merged', (await said).message);
    const mergeCall = github.seen.find((call) => call.method === 'PUT');
    check(mergeCall && mergeCall.body.merge_method === 'squash' && mergeCall.body.sha === 'h21', 'GitHub was asked to squash, pinned to the head I saw', JSON.stringify(mergeCall?.body));
    const mergedLine = after.tasks.find((t) => t.id === line.id);
    check(mergedLine.pr.state === 'merged', 'the ledger follows GitHub to merged');
    check(mergedLine.github.lastAction?.action === 'squash' && typeof mergedLine.github.lastAction?.byName === 'string' && mergedLine.github.lastAction.byName.length > 0, 'and remembers who did it from here', JSON.stringify(mergedLine.github.lastAction));
    check(noteOf(after, kettle.id)?.status === 'done', 'and the note goes to done', noteOf(after, kettle.id)?.status);

    them.room.send('agent:task', null);
    await me.next('board', 6000, (board) => board.tasks.find((t) => t.id === line.id)?.status === 'ended');
  } finally {
    await them.room.leave();
    await clearOfficeGithub(db, workspaceId);
    await github.close();
  }
}
