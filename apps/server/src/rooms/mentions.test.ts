import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressedNames } from '@quintal/shared';

import { absentNotice, resolveMentions } from './mentions.js';

/**
 * `@engineering` has to mean exactly the members who can hear it, each told
 * about the others — and has to say, once, who it could not reach. Getting
 * either wrong is a reviewer who never saw the request, or three who all
 * start it.
 */

const josh = { id: 'u-josh', name: 'Josh', kind: 'human' as const };
const claude = { id: 'a-claude', name: 'Claude', kind: 'agent' as const };
const codex = { id: 'a-codex', name: 'Codex', kind: 'agent' as const };
const grok = { id: 'a-grok', name: 'Grok', kind: 'agent' as const };
const engineering = {
  id: 't-eng',
  name: 'engineering',
  members: [claude, codex, grok].map(({ id, name }) => ({ id, name })),
};

describe('resolving a team mention', () => {
  it('reaches the members present, tells each about the others, and names the absent one', () => {
    const { reached, absent } = resolveMentions(
      ['engineering'],
      [josh, claude, codex],
      [engineering],
      josh.id,
    );
    assert.deepEqual([...reached.keys()].sort(), [claude.id, codex.id]);
    assert.deepEqual(reached.get(claude.id)?.viaTeam, { name: 'engineering', members: ['Codex'] });
    assert.deepEqual(reached.get(codex.id)?.viaTeam, { name: 'engineering', members: ['Claude'] });
    assert.deepEqual(absent, [{ team: 'engineering', names: ['Grok'] }]);
  });

  it('is case-insensitive, like every other mention', () => {
    const { reached } = resolveMentions(['ENGINEERING'], [josh, claude], [engineering], josh.id);
    assert.equal(reached.has(claude.id), true);
  });

  it('never addresses the speaker, even as a teammate', () => {
    const { reached } = resolveMentions(['engineering'], [claude, codex], [engineering], claude.id);
    assert.deepEqual([...reached.keys()], [codex.id]);
    assert.deepEqual(reached.get(codex.id)?.viaTeam?.members, [], 'nobody else was reached');
  });

  it('keeps a direct mention direct when the team is named too', () => {
    const { reached } = resolveMentions(
      ['claude', 'engineering'],
      [josh, claude, codex],
      [engineering],
      josh.id,
    );
    assert.equal(reached.get(claude.id)?.viaTeam, undefined, 'Claude was asked by name');
    assert.equal(reached.get(codex.id)?.viaTeam?.name, 'engineering');
  });

  it('says nothing about a team nobody named, and leaves plain names as they were', () => {
    const { reached, absent } = resolveMentions(['codex'], [josh, claude, codex], [engineering], josh.id);
    assert.deepEqual([...reached.keys()], [codex.id]);
    assert.deepEqual(absent, []);
  });
});

describe('the notice for who was out of reach', () => {
  it('reads as a sentence, one per team, and is null when everyone was reached', () => {
    assert.equal(absentNotice([], '#engineering'), null);
    assert.equal(
      absentNotice([{ team: 'engineering', names: ['Grok'] }], '#engineering'),
      '@engineering: Grok is not in #engineering.',
    );
    assert.equal(
      absentNotice([{ team: 'engineering', names: ['Codex', 'Grok'] }], 'the office right now'),
      '@engineering: Codex and Grok are not in the office right now.',
    );
  });
});

describe('a person called by their key', () => {
  it('is reached by name, ellipsis and all, through the same resolver', () => {
    const stranger = { id: 'u-2', name: 'npub1rww4uhaw…nlarug', kind: 'human' as const };
    const audience = [josh, stranger, claude];
    const named = addressedNames('@npub1rww4uhaw…nlarug can you look?', audience.map((m) => m.name));
    const { reached } = resolveMentions(named, audience, [], josh.id);
    assert.deepEqual([...reached.keys()], [stranger.id]);
  });
});
