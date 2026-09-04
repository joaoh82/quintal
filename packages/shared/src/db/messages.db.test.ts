import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { FLOOR_ZONE_ID } from '../conversation.js';
import {
  ensureZoneConversations,
  mentionsOf,
  recentMessages,
  recentMessagesNear,
  recordMessage,
} from './messages.js';
import { conversations, messages } from './schema.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * A transcript belongs to a zone, and a zone belongs to an office.
 *
 * The properties worth a real database: that an office cannot read another's
 * words through any of the three readers; that the zone rows a room opens with
 * are the same rows next time, history intact; that "nearby" is a question
 * about distance and not about which transcript a message happened to land
 * in; and that a mention is findable by the one it was for.
 */

const ZONES = [
  { id: 'lobby', label: 'Lobby' },
  { id: 'focus', label: 'Focus Room' },
];

async function office(db: Awaited<ReturnType<typeof createTestDb>>, name: string) {
  const owner = await createTestUser(db, name);
  const zones = await ensureZoneConversations(db, owner.workspaceId, 'hq', ZONES);
  return { owner, zones };
}

function said(
  conversationId: string,
  from: { id: string; name: string },
  text: string,
  sentAt: number,
  at: { x: number; y: number } = { x: 0, y: 0 },
  mentions: string[] = [],
) {
  return {
    conversationId,
    fromId: from.id,
    fromKind: 'human' as const,
    fromName: from.name,
    text,
    sentAt,
    ...at,
    mentions,
  };
}

describe('zone transcripts', () => {
  it('opens one transcript per zone, plus the floor', async () => {
    const db = await createTestDb();
    const { zones } = await office(db, 'Ana');

    assert.deepEqual([...zones.keys()].sort(), ['focus', FLOOR_ZONE_ID, 'lobby'].sort());
  });

  it('keeps the same rows — and their history — when the room opens again', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const lobby = zones.get('lobby');
    assert.ok(lobby);
    await recordMessage(db, said(lobby, owner, 'hello', 1_000));

    // Second boot, with the lobby renamed in the map editor meanwhile.
    const again = await ensureZoneConversations(db, owner.workspaceId, 'hq', [
      { id: 'lobby', label: 'Reception' },
      { id: 'focus', label: 'Focus Room' },
    ]);

    assert.equal(again.get('lobby'), lobby, 'a renamed zone is the same zone');
    const page = await recentMessages(db, lobby, { workspaceId: owner.workspaceId });
    assert.equal(page.messages.length, 1, 'renaming a zone does not lose its past');
    const row = (await db.select().from(conversations).where(eq(conversations.id, lobby)))[0];
    assert.equal(row?.name, 'Reception');
  });

  it('writes the office from the conversation, not from the caller', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const lobby = zones.get('lobby');
    assert.ok(lobby);

    const id = await recordMessage(db, said(lobby, owner, 'hello', 1_000));

    const row = (await db.select().from(messages).where(eq(messages.id, id)))[0];
    assert.equal(row?.workspaceId, owner.workspaceId);
  });
});

describe('reading a transcript', () => {
  it('returns the newest messages, oldest first, and says when there are more', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const lobby = zones.get('lobby');
    assert.ok(lobby);
    for (let i = 1; i <= 5; i += 1) {
      await recordMessage(db, said(lobby, owner, `m${i}`, i * 1_000));
    }

    const page = await recentMessages(db, lobby, { workspaceId: owner.workspaceId, limit: 3 });

    assert.deepEqual(
      page.messages.map((m) => m.text),
      ['m3', 'm4', 'm5'],
      'the last three, in the order a transcript is read',
    );
    assert.equal(page.hasMore, true);

    const earlier = await recentMessages(db, lobby, {
      workspaceId: owner.workspaceId,
      limit: 3,
      before: page.messages[0]?.sentAt,
    });
    assert.deepEqual(earlier.messages.map((m) => m.text), ['m1', 'm2']);
    assert.equal(earlier.hasMore, false);
  });

  it('never hands one office another office\'s words', async () => {
    const db = await createTestDb();
    const ana = await office(db, 'Ana');
    const bo = await office(db, 'Bo');
    const anaLobby = ana.zones.get('lobby');
    const boLobby = bo.zones.get('lobby');
    assert.ok(anaLobby && boLobby);
    assert.notEqual(anaLobby, boLobby, 'two offices, two lobbies');

    await recordMessage(
      db,
      said(anaLobby, ana.owner, 'secret', 1_000, { x: 0, y: 0 }, [bo.owner.id]),
    );

    // By transcript: Bo's office naming Ana's conversation id reads nothing.
    const byZone = await recentMessages(db, anaLobby, { workspaceId: bo.owner.workspaceId });
    assert.equal(byZone.messages.length, 0);

    // By distance: standing on the exact spot, in the other office.
    const nearby = await recentMessagesNear(db, {
      workspaceId: bo.owner.workspaceId,
      mapId: 'hq',
      x: 0,
      y: 0,
      radius: 100,
    });
    assert.equal(nearby.messages.length, 0);

    // By mention: even addressed by name, across an office boundary.
    const mentioned = await mentionsOf(db, bo.owner.id, { workspaceId: bo.owner.workspaceId });
    assert.equal(mentioned.messages.length, 0);
  });
});

describe('what could be heard from here', () => {
  it('is a question of distance, not of which zone the words landed in', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const lobby = zones.get('lobby');
    const floor = zones.get(FLOOR_ZONE_ID);
    assert.ok(lobby && floor);

    // Said by the doorway, from either side of it.
    await recordMessage(db, said(lobby, owner, 'inside', 1_000, { x: 100, y: 100 }));
    await recordMessage(db, said(floor, owner, 'outside', 2_000, { x: 120, y: 100 }));
    await recordMessage(db, said(floor, owner, 'far away', 3_000, { x: 900, y: 900 }));

    const heard = await recentMessagesNear(db, {
      workspaceId: owner.workspaceId,
      mapId: 'hq',
      x: 110,
      y: 100,
      radius: 50,
    });

    assert.deepEqual(heard.messages.map((m) => m.text), ['inside', 'outside']);
  });
});

describe('what was said to me', () => {
  it('finds a message by who it named, wherever it was said', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const marvin = { id: 'agent-marvin', name: 'Marvin' };
    const focus = zones.get('focus');
    assert.ok(focus);

    await recordMessage(
      db,
      said(focus, owner, '@Marvin come here', 1_000, { x: 900, y: 900 }, [marvin.id]),
    );
    await recordMessage(db, said(focus, owner, 'talking to myself', 2_000, { x: 900, y: 900 }));

    const mine = await mentionsOf(db, marvin.id, { workspaceId: owner.workspaceId });

    assert.deepEqual(mine.messages.map((m) => m.text), ['@Marvin come here']);
  });

  it('records each person once however many times a line names them', async () => {
    const db = await createTestDb();
    const { owner, zones } = await office(db, 'Ana');
    const lobby = zones.get('lobby');
    assert.ok(lobby);

    // Must not throw on the duplicate, and must not double-count.
    await recordMessage(
      db,
      said(lobby, owner, '@Marvin @Marvin', 1_000, { x: 0, y: 0 }, ['agent-marvin', 'agent-marvin']),
    );

    const mine = await mentionsOf(db, 'agent-marvin', { workspaceId: owner.workspaceId });
    assert.equal(mine.messages.length, 1);
  });
});
