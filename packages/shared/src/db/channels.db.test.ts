import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dmKey, mayAddToChannel, mayOpenDm, mayRemoveFromChannel } from '../conversation.js';
import { createAgent } from './agents.js';
import {
  ChannelNameError,
  addChannelMember,
  channelMembershipForWorkspace,
  createChannel,
  isChannelMember,
  listChannels,
  listChannelsForMember,
  openDm,
  removeChannelMember,
} from './channels.js';
import { mentionsOf, recentMessages, recordMessage } from './messages.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * A channel names its members, and an office cannot see another's channels.
 *
 * The rules about who may put whom into a channel are pure functions and are
 * tested as such below — the one that matters most is that nobody but an
 * agent's owner can add it, because an agent answers as its owner. The
 * database tests are about identity: that a channel is one row per name per
 * office, that membership resolves to current names, and that the readers
 * QUIN-4 built work unchanged on a channel's transcript.
 */

describe('who may add whom', () => {
  const owner = { userId: 'u-owner', role: 'owner' as const };
  const member = { userId: 'u-member', role: 'member' as const };
  const guest = { userId: 'u-guest', role: null };
  const agentOfMember = { id: 'a-1', kind: 'agent' as const, ownerUserId: 'u-member' };
  const person = { id: 'u-other', kind: 'human' as const };

  it('lets any member add a person', () => {
    assert.equal(mayAddToChannel(member, person), true);
  });

  it("lets only an agent's owner add it — not even the office owner", () => {
    assert.equal(mayAddToChannel(member, agentOfMember), true);
    assert.equal(
      mayAddToChannel(owner, agentOfMember),
      false,
      'an agent answers as its owner; nobody else puts words in front of it',
    );
  });

  it('lets a guest add nobody, themselves included', () => {
    assert.equal(mayAddToChannel(guest, person), false);
    assert.equal(mayAddToChannel(guest, { id: 'u-guest', kind: 'human' }), false);
  });
});

describe('who may remove whom', () => {
  const owner = { userId: 'u-owner', role: 'owner' as const };
  const maker = { userId: 'u-maker', role: 'member' as const };
  const member = { userId: 'u-member', role: 'member' as const };
  const channel = { createdBy: 'u-maker' };
  const agentOfMember = { id: 'a-1', kind: 'agent' as const, ownerUserId: 'u-member' };

  it('lets anyone leave', () => {
    assert.equal(mayRemoveFromChannel(member, channel, { id: 'u-member', kind: 'human' }), true);
  });

  it('lets the maker or an admin remove a person, and nobody else', () => {
    const other = { id: 'u-other', kind: 'human' as const };
    assert.equal(mayRemoveFromChannel(maker, channel, other), true);
    assert.equal(mayRemoveFromChannel(owner, channel, other), true);
    assert.equal(mayRemoveFromChannel(member, channel, other), false);
  });

  it("lets an agent's owner or an admin remove it — the people who could revoke it", () => {
    assert.equal(mayRemoveFromChannel(member, channel, agentOfMember), true);
    assert.equal(mayRemoveFromChannel(owner, channel, agentOfMember), true);
    assert.equal(
      mayRemoveFromChannel(maker, channel, agentOfMember),
      false,
      'making the channel does not make you accountable for the agent',
    );
  });
});

describe('who may message whom directly', () => {
  const member = { userId: 'u-member', role: 'member' as const };
  const owner = { userId: 'u-owner', role: 'owner' as const };
  const guest = { userId: 'u-guest', role: null };
  const myAgent = {
    id: 'a-1',
    kind: 'agent' as const,
    ownerUserId: 'u-member',
    scopes: ['chat', 'dm'],
  };

  it('lets any member message any other person', () => {
    assert.equal(mayOpenDm(member, { id: 'u-other', kind: 'human' }), true);
  });

  it("lets only an agent's owner message it — the most private place there is", () => {
    assert.equal(mayOpenDm(member, myAgent), true);
    assert.equal(mayOpenDm(owner, myAgent), false, 'not even the office owner');
  });

  it('refuses an agent without the dm scope, even to its owner', () => {
    assert.equal(mayOpenDm(member, { ...myAgent, scopes: ['chat'] }), false);
  });

  it('refuses guests, and refuses talking to yourself', () => {
    assert.equal(mayOpenDm(guest, { id: 'u-other', kind: 'human' }), false);
    assert.equal(mayOpenDm(member, { id: 'u-member', kind: 'human' }), false);
  });

  it('names a pair the same way round whoever asks', () => {
    assert.equal(dmKey('b', 'a'), dmKey('a', 'b'));
    assert.match(dmKey('a', 'b'), /^dm:/, 'never collides with a channel slug');
  });
});

describe('a direct message', () => {
  it('is one row for the pair, found again from either side, with both in it', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const marvin = await createAgent(db, {
      workspaceId: ana.workspaceId,
      ownerUserId: ana.id,
      name: 'Marvin',
      spriteKey: 'slate',
    });

    const first = await openDm(db, {
      workspaceId: ana.workspaceId,
      openerId: ana.id,
      other: { id: marvin.id, kind: 'agent' },
    });
    const again = await openDm(db, {
      workspaceId: ana.workspaceId,
      openerId: ana.id,
      other: { id: marvin.id, kind: 'agent' },
    });

    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.id, first.id, 'opening it twice is one conversation');
    assert.equal(await isChannelMember(db, first.id, ana.id), true);
    assert.equal(await isChannelMember(db, first.id, marvin.id), true);
  });

  it('is nowhere a channel is listed, but the room knows it', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const bo = await createTestUser(db, 'Bo', ana.workspaceId);
    const { id } = await openDm(db, {
      workspaceId: ana.workspaceId,
      openerId: ana.id,
      other: { id: bo.id, kind: 'human' },
    });

    assert.deepEqual(await listChannels(db, ana.workspaceId), [], 'the settings page never sees it');

    const known = await channelMembershipForWorkspace(db, ana.workspaceId);
    const dm = known.get(id);
    assert.ok(dm, 'the room does — it has to deliver it');
    assert.equal(dm.kind, 'dm');
    assert.equal(dm.slug, '', 'a pair key is an identifier, not something to print');
    assert.deepEqual([...dm.members.values()].map((m) => m.name).sort(), ['Ana', 'Bo']);
  });
});

describe('making a channel', () => {
  it('puts its maker in it', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');

    const channel = await createChannel(db, {
      workspaceId: ana.workspaceId,
      name: 'Engineering',
      createdBy: ana.id,
    });

    assert.equal(channel.slug, 'engineering');
    assert.equal(await isChannelMember(db, channel.id, ana.id), true);
    assert.deepEqual(
      (await listChannelsForMember(db, ana.workspaceId, ana.id)).map((c) => c.slug),
      ['engineering'],
    );
  });

  it('refuses a second channel by the same name in one office, and allows it in another', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const bo = await createTestUser(db, 'Bo');
    await createChannel(db, { workspaceId: ana.workspaceId, name: 'Ops', createdBy: ana.id });

    await assert.rejects(
      createChannel(db, { workspaceId: ana.workspaceId, name: 'ops!', createdBy: ana.id }),
      (error: unknown) => error instanceof ChannelNameError && error.reason === 'taken',
    );
    await assert.doesNotReject(
      createChannel(db, { workspaceId: bo.workspaceId, name: 'Ops', createdBy: bo.id }),
      'a name is unique in an office, not across the deployment',
    );
  });

  it('refuses a name with nothing in it', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    await assert.rejects(
      createChannel(db, { workspaceId: ana.workspaceId, name: '!!!', createdBy: ana.id }),
      (error: unknown) => error instanceof ChannelNameError && error.reason === 'invalid',
    );
  });
});

describe('membership', () => {
  it('resolves members to their current names, people and agents alike', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const marvin = await createAgent(db, {
      workspaceId: ana.workspaceId,
      ownerUserId: ana.id,
      name: 'Marvin',
      spriteKey: 'slate',
    });
    const channel = await createChannel(db, {
      workspaceId: ana.workspaceId,
      name: 'Engineering',
      createdBy: ana.id,
    });
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: marvin.id,
      memberKind: 'agent',
      addedBy: ana.id,
    });
    // Twice is once.
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: marvin.id,
      memberKind: 'agent',
      addedBy: ana.id,
    });

    const [listed] = await listChannels(db, ana.workspaceId);
    assert.ok(listed);
    // Compared as a set: both were added within the same millisecond, and
    // the order among equals is the query's business, not this test's.
    assert.deepEqual(
      listed.members.map((m) => [m.name, m.kind, m.ownerUserId]).sort(),
      [
        ['Ana', 'human', null],
        ['Marvin', 'agent', ana.id],
      ],
    );

    const byChannel = await channelMembershipForWorkspace(db, ana.workspaceId);
    assert.equal(byChannel.get(channel.id)?.members.get(marvin.id)?.name, 'Marvin');

    await removeChannelMember(db, channel.id, marvin.id);
    assert.equal(await isChannelMember(db, channel.id, marvin.id), false);
  });

  it("does not show one office another office's channels", async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const bo = await createTestUser(db, 'Bo');
    const channel = await createChannel(db, {
      workspaceId: ana.workspaceId,
      name: 'Secret',
      createdBy: ana.id,
    });
    // Bo is somehow a member row — a bug elsewhere, say. Bo's office still
    // cannot see it, because the channel belongs to Ana's.
    await addChannelMember(db, {
      channelId: channel.id,
      memberId: bo.id,
      memberKind: 'human',
      addedBy: ana.id,
    });

    assert.deepEqual(await listChannels(db, bo.workspaceId), []);
    assert.deepEqual(await listChannelsForMember(db, bo.workspaceId, bo.id), []);
    assert.equal((await channelMembershipForWorkspace(db, bo.workspaceId)).size, 0);
  });
});

describe("a channel's transcript", () => {
  it('is read and mention-indexed exactly like a zone', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const channel = await createChannel(db, {
      workspaceId: ana.workspaceId,
      name: 'Engineering',
      createdBy: ana.id,
    });

    await recordMessage(db, {
      conversationId: channel.id,
      fromId: ana.id,
      fromKind: 'human',
      fromName: 'Ana',
      text: '@Marvin review #12',
      sentAt: 1_000,
      mentions: ['agent-marvin'],
    });

    const page = await recentMessages(db, channel.id, { workspaceId: ana.workspaceId });
    assert.equal(page.messages[0]?.text, '@Marvin review #12');
    assert.equal(page.messages[0]?.x, null, 'a channel has no "where"');

    const mine = await mentionsOf(db, 'agent-marvin', { workspaceId: ana.workspaceId });
    assert.equal(mine.messages.length, 1);
  });
});
