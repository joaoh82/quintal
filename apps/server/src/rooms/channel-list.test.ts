import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChannelRef } from '@quintal/shared';

import { SentChannelLists, agentTeamsSignature, channelListSignature } from './channel-list.js';

function channel(slug: string): ChannelRef {
  return { id: `id-${slug}`, kind: 'channel', name: slug, slug };
}

describe('when a channel list counts as changed', () => {
  it('changes when a channel moves from joinable to joined', () => {
    // The bug: the same channels in the same order, split differently, must
    // not fingerprint the same — that is exactly what a join looks like.
    const before = channelListSignature([channel('engineering')], [channel('design')]);
    const after = channelListSignature([channel('engineering'), channel('design')], []);
    assert.notEqual(before, after);
  });

  it('is the same for the same lists', () => {
    assert.equal(
      channelListSignature([channel('a')], [channel('b')]),
      channelListSignature([channel('a')], [channel('b')]),
    );
  });

  it('notices a rename', () => {
    const renamed = { ...channel('a'), name: 'A team' };
    assert.notEqual(channelListSignature([channel('a')], []), channelListSignature([renamed], []));
  });

  /**
   * A read on one machine has to reach the others, and the list is the only
   * thing that carries it. Nothing broadcasts a cursor the way a line
   * broadcasts itself, so if the fingerprint ignored it the desktop would
   * keep its dot until something unrelated changed.
   */
  it('notices that the same person has read further', () => {
    const read = { ...channel('a'), lastReadAt: 5_000 };
    const later = { ...channel('a'), lastReadAt: 9_000 };

    assert.notEqual(channelListSignature([channel('a')], []), channelListSignature([read], []));
    assert.notEqual(channelListSignature([read], []), channelListSignature([later], []));
    assert.equal(channelListSignature([read], []), channelListSignature([{ ...read }], []));
  });

  /**
   * And the opposite, for the thing every session already hears about: a new
   * line arrives as `channel_chat` on its own, so resending the whole list
   * for it would be noise — and a list that arrives constantly is one clients
   * learn to ignore.
   */
  it('says nothing about a new line, which arrives on its own', () => {
    const spoke = { ...channel('a'), lastMessageAt: 9_000 };
    assert.equal(channelListSignature([channel('a')], []), channelListSignature([spoke], []));
  });
});

describe('teams on the same list', () => {
  const team = (name: string, members: string[]) => ({
    id: `t-${name}`,
    name,
    description: '',
    members: members.map((id) => ({ id, name: id })),
  });

  it('changes when a team is renamed or gains a member, and not otherwise', () => {
    const base = channelListSignature([], [], [team('eng', ['a'])]);
    assert.equal(channelListSignature([], [], [team('eng', ['a'])]), base);
    assert.notEqual(channelListSignature([], [], [team('design', ['a'])]), base);
    assert.notEqual(channelListSignature([], [], [team('eng', ['a', 'b'])]), base);
    assert.notEqual(channelListSignature([], [], []), base);
  });
});

describe("what an agent is told about its teams counts as changed", () => {
  const team = (over: Partial<{ name: string; instructions: string; members: string[] }> = {}) => ({
    id: 't-eng',
    name: 'engineering',
    description: 'Reviews.',
    instructions: 'Claim first.',
    members: ['Claude', 'Codex'],
    ...over,
  });

  it('changes on a rename, a new instruction or a new member, and not otherwise', () => {
    const base = agentTeamsSignature([team()]);
    assert.equal(agentTeamsSignature([team()]), base);
    assert.notEqual(agentTeamsSignature([team({ name: 'eng' })]), base);
    assert.notEqual(agentTeamsSignature([team({ instructions: 'Ask first.' })]), base);
    assert.notEqual(agentTeamsSignature([team({ members: ['Claude', 'Codex', 'Grok'] })]), base);
    assert.notEqual(agentTeamsSignature([]), base, 'leaving the team is a change');
  });
});

describe('what has already been sent to a session', () => {
  it('sends a list once, and again only when it changes', () => {
    const sent = new SentChannelLists();
    assert.equal(sent.offer('s1', 'a|b|'), true);
    assert.equal(sent.offer('s1', 'a|b|'), false, 'the same list is not news');
    assert.equal(sent.offer('s1', 'a,c|b|'), true);
    assert.equal(sent.offer('s2', 'a,c|b|'), true, 'another session has heard nothing yet');
  });

  /**
   * The bug. The room pushed the list right after a join, before the browser
   * had a handler for it, so the push was dropped. The browser then asked and
   * got nothing back — same fingerprint, "already sent" — and showed no
   * channels and no DMs until something unrelated changed the list.
   */
  it('answers a request even with the list it pushed a moment before', () => {
    const sent = new SentChannelLists();
    assert.equal(sent.offer('s1', 'a|b|'), true, 'the push nobody was listening for');

    sent.asked('s1');
    assert.equal(sent.offer('s1', 'a|b|'), true, 'the answer to the request');
    assert.equal(sent.offer('s1', 'a|b|'), false, 'and the next unchanged refresh stays quiet');
  });

  it('forgets a session that has gone', () => {
    const sent = new SentChannelLists();
    sent.offer('s1', 'a|b|');
    sent.forget('s1');
    assert.equal(sent.offer('s1', 'a|b|'), true);
  });
});
