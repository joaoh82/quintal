import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChannelRef } from '@quintal/shared';

import { joinTargets, matchJoinTargets, resolveJoin } from './join.js';

/**
 * `/join` means "take me there", whatever "there" is: a channel you are in,
 * one you could be in, or one that does not exist. Each is a different
 * answer, and the old code gave the first two the same one.
 */

function channel(slug: string, kind: ChannelRef['kind'] = 'channel'): ChannelRef {
  return { id: `id-${slug}`, kind, slug, name: slug } as ChannelRef;
}

const MINE = [channel('engineering'), channel('sam', 'dm')];
const OPEN = [channel('general'), channel('design')];

describe('what /join does', () => {
  it('switches to a channel you are already in, however you wrote it', () => {
    for (const written of ['engineering', '#engineering', ' #Engineering ']) {
      const result = resolveJoin(written, MINE, OPEN);
      assert.equal(result.kind, 'switch');
      if (result.kind === 'switch') assert.equal(result.channel.slug, 'engineering');
    }
  });

  it('joins one you could be in', () => {
    assert.deepEqual(resolveJoin('#design', MINE, OPEN), { kind: 'join', slug: 'design' });
  });

  it('says so for one that does not exist, and asks for a pick when given nothing', () => {
    assert.deepEqual(resolveJoin('nope', MINE, OPEN), { kind: 'unknown', slug: 'nope' });
    assert.deepEqual(resolveJoin('', MINE, OPEN), { kind: 'pick' });
    assert.deepEqual(resolveJoin('#', MINE, OPEN), { kind: 'pick' });
  });

  it('never treats a DM as a channel to join', () => {
    assert.equal(resolveJoin('sam', MINE, OPEN).kind, 'unknown');
  });
});

describe('what the picker offers', () => {
  it('lists yours first, then the open ones, and never a DM', () => {
    assert.deepEqual(joinTargets(MINE, OPEN), [
      { slug: 'engineering', joined: true },
      { slug: 'general', joined: false },
      { slug: 'design', joined: false },
    ]);
  });

  it('filters as you type, prefix matches first, # ignored', () => {
    const targets = joinTargets([channel('general-engineering')], [channel('engineering'), channel('design')]);
    assert.deepEqual(
      matchJoinTargets(targets, 'en').map((t) => t.slug),
      ['engineering', 'general-engineering'],
    );
    assert.deepEqual(matchJoinTargets(targets, '#des').map((t) => t.slug), ['design']);
    assert.equal(matchJoinTargets(targets, '').length, 3, 'nothing typed lists everything');
    assert.deepEqual(matchJoinTargets(targets, 'zzz'), []);
  });
});
