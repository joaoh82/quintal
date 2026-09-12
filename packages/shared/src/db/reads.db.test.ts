import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addChannelMember, createChannel } from './channels.js';
import { markRead, readCursorsForMember } from './reads.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * Where somebody is in a conversation, kept by the office.
 *
 * The cursor only ever moves forward. Two devices are the whole point of
 * this, and two devices report out of order: a laptop that read at 12:05 and
 * a phone whose 12:00 report was stuck behind a reconnect must leave the
 * cursor at 12:05. Anything that reads the current value and then writes a
 * new one loses that race, so the guard belongs in the statement.
 */
describe('where somebody is in a conversation', () => {
  async function office(name: string) {
    const db = await createTestDb();
    const owner = await createTestUser(db, name);
    const channel = await createChannel(db, {
      workspaceId: owner.workspaceId,
      name: 'Engineering',
      createdBy: owner.id,
    });
    return { db, owner, channel };
  }

  it('starts nowhere, and remembers once you look', async () => {
    const { db, owner, channel } = await office('Josh');

    assert.deepEqual(
      [...(await readCursorsForMember(db, owner.workspaceId, owner.id))],
      [],
      'a channel nobody has opened has no cursor, not a zero',
    );

    const moved = await markRead(db, {
      workspaceId: owner.workspaceId,
      conversationId: channel.id,
      memberId: owner.id,
      at: 1_000,
    });

    assert.equal(moved, true);
    assert.deepEqual(
      [...(await readCursorsForMember(db, owner.workspaceId, owner.id))],
      [[channel.id, 1_000]],
    );
  });

  it('never goes backwards, however the reports arrive', async () => {
    const { db, owner, channel } = await office('Josh');
    const where = { workspaceId: owner.workspaceId, conversationId: channel.id, memberId: owner.id };

    await markRead(db, { ...where, at: 5_000 });
    const backwards = await markRead(db, { ...where, at: 1_000 });

    assert.equal(backwards, false, 'a late report from an older device is not news');
    assert.equal((await readCursorsForMember(db, owner.workspaceId, owner.id)).get(channel.id), 5_000);

    // And the same instant twice is not movement either: two tabs noticing the
    // same line must not make the office tell everybody twice.
    assert.equal(await markRead(db, { ...where, at: 5_000 }), false);

    await markRead(db, { ...where, at: 9_000 });
    assert.equal((await readCursorsForMember(db, owner.workspaceId, owner.id)).get(channel.id), 9_000);
  });

  it('belongs to one person, and is not a fact about the channel', async () => {
    const { db, owner, channel } = await office('Josh');
    const sam = await createTestUser(db, 'Sam', { workspaceId: owner.workspaceId });
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: sam.id,
      memberKind: 'human',
      addedBy: owner.id,
    });

    await markRead(db, {
      workspaceId: owner.workspaceId,
      conversationId: channel.id,
      memberId: owner.id,
      at: 7_000,
    });

    assert.equal(
      (await readCursorsForMember(db, owner.workspaceId, sam.id)).get(channel.id),
      undefined,
      'Josh reading it is not Sam reading it',
    );
  });

  /**
   * The write is the membership check.
   *
   * There is no separate "are you in this?" query to forget to call: the
   * statement updates a membership row, so somebody who is not a member
   * matches nothing.
   */
  it('writes nothing for somebody who is not in the conversation', async () => {
    const { db, owner, channel } = await office('Josh');
    const stranger = await createTestUser(db, 'Stranger');

    const moved = await markRead(db, {
      workspaceId: owner.workspaceId,
      conversationId: channel.id,
      memberId: stranger.id,
      at: 3_000,
    });

    assert.equal(moved, false);
    assert.deepEqual([...(await readCursorsForMember(db, owner.workspaceId, stranger.id))], []);
  });

  it('writes nothing when the office named is not the one the channel is in', async () => {
    const { db, owner, channel } = await office('Josh');
    const elsewhere = await createTestUser(db, 'Ana');

    const moved = await markRead(db, {
      workspaceId: elsewhere.workspaceId,
      conversationId: channel.id,
      memberId: owner.id,
      at: 3_000,
    });

    assert.equal(moved, false, 'naming another office must not reach into this one');
    assert.deepEqual([...(await readCursorsForMember(db, owner.workspaceId, owner.id))], []);
  });

  it('reads back only this office, for somebody who is in two', async () => {
    const { db, owner, channel } = await office('Josh');
    const other = await createTestUser(db, 'Josh elsewhere');
    const far = await createChannel(db, {
      workspaceId: other.workspaceId,
      name: 'Elsewhere',
      createdBy: other.id,
    });

    await markRead(db, {
      workspaceId: owner.workspaceId,
      conversationId: channel.id,
      memberId: owner.id,
      at: 4_000,
    });
    await markRead(db, {
      workspaceId: other.workspaceId,
      conversationId: far.id,
      memberId: other.id,
      at: 8_000,
    });

    assert.deepEqual(
      [...(await readCursorsForMember(db, owner.workspaceId, owner.id))],
      [[channel.id, 4_000]],
    );
  });
});
