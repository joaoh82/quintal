import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChannelRef } from '@quintal/shared';

import { channelListSignature } from './channel-list.js';

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
