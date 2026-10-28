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
 *   node scripts/board-smoke.mjs [baseUrl]
 *
 * Needs a server already running (`pnpm dev` or `pnpm start`) on the same
 * database this script opens: `DATABASE_URL`, or the default
 * `data/quintal.db` at the repo root.
 */
import { randomUUID } from 'node:crypto';

import {
  buildAuthPayload,
  generateSecretKey,
  getPublicKeyHex,
  signAuthPayload,
} from '@quintal/shared';
import { getClient } from '@quintal/shared/db';

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
async function enter(options) {
  const { Client } = await import('colyseus.js');
  const client = new Client(`${base}/colyseus`);
  const room = await client.joinOrCreate('office', { mapId: 'hq', ...options });
  const inbox = { board: [], error: [], notice: [] };
  const waiters = [];
  const deliver = (kind, payload) => {
    inbox[kind].push(payload);
    for (const waiter of waiters.splice(0)) waiter({ kind, payload });
  };
  room.onMessage('*', () => {});
  room.onMessage('board', (payload) => deliver('board', payload));
  room.onMessage('error', (payload) => deliver('error', payload));
  room.onMessage('notice', (payload) => deliver('notice', payload));
  const next = (kind, ms = 4000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${kind} within ${ms}ms`)), ms);
      const waiter = ({ kind: got, payload }) => {
        if (got !== kind) {
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
  check(refusedAssignee.code === 'invalid_payload', 'a note cannot be for an agent that is not here', refusedAssignee.message);

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
