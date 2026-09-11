import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OFFICE_SETTINGS,
  addressedNames,
  applyMention,
  isAddressed,
  mentionQueryAt,
  mentionedNames,
  normaliseSettings,
} from './settings.js';

describe('normaliseSettings', () => {
  it('falls back to defaults for junk', () => {
    assert.deepEqual(normaliseSettings(null), DEFAULT_OFFICE_SETTINGS);
    assert.equal(normaliseSettings({ chatRadiusTiles: NaN }).chatRadiusTiles, 12);
  });

  it('clamps rather than trusting the caller', () => {
    // A settings form is an input like any other; a radius of 10^9 would make
    // every message a broadcast to the whole map.
    assert.equal(normaliseSettings({ chatRadiusTiles: 100_000 }).chatRadiusTiles, 40);
    assert.equal(normaliseSettings({ chatRadiusTiles: -5 }).chatRadiusTiles, 2);
    assert.equal(normaliseSettings({ walkUpRadiusTiles: 0 }).walkUpRadiusTiles, 1);
  });

  it('allows zero reply window, which turns the behaviour off', () => {
    assert.equal(normaliseSettings({ replyWindowSeconds: 0 }).replyWindowSeconds, 0);
  });

  it('keeps agent parallelism between one and thirty-two, ten by default', () => {
    // A row written before the column existed, and a form that sent nothing.
    assert.equal(normaliseSettings(null).agentParallelism, 10);
    assert.equal(normaliseSettings({}).agentParallelism, 10);
    // Zero would be an agent that never answers; it is not a setting.
    assert.equal(normaliseSettings({ agentParallelism: 0 }).agentParallelism, 1);
    assert.equal(normaliseSettings({ agentParallelism: 500 }).agentParallelism, 32);
    assert.equal(normaliseSettings({ agentParallelism: 4 }).agentParallelism, 4);
  });

  it('keeps mention hops between one and sixteen, four by default', () => {
    // A row from before the column existed, and a form that sent nothing.
    assert.equal(normaliseSettings(null).mentionMaxHops, 4);
    assert.equal(normaliseSettings({}).mentionMaxHops, 4);
    // Zero would mean a person's line wakes nobody; it is not a setting.
    assert.equal(normaliseSettings({ mentionMaxHops: 0 }).mentionMaxHops, 1);
    assert.equal(normaliseSettings({ mentionMaxHops: 99 }).mentionMaxHops, 16);
    assert.equal(normaliseSettings({ mentionMaxHops: 8 }).mentionMaxHops, 8);
  });

  it('leaves idle life on unless an office turned it off', () => {
    assert.equal(normaliseSettings(null).idleLife, true);
    assert.equal(normaliseSettings({}).idleLife, true);
    assert.equal(normaliseSettings({ idleLife: false }).idleLife, false);
    // A row written as 0/1 by the database, not a boolean.
    assert.equal(normaliseSettings({ idleLife: 0 as unknown as boolean }).idleLife, false);
  });

  it('keeps banter off unless an office chose the one mode that costs tokens', () => {
    assert.equal(normaliseSettings(null).banter, 'off');
    assert.equal(normaliseSettings({ banter: 'rare' }).banter, 'rare');
    assert.equal(normaliseSettings({ banter: 'often' as unknown as 'rare' }).banter, 'off');
    assert.equal(normaliseSettings({ banter: true as unknown as 'rare' }).banter, 'off');
  });
});

describe('addressing', () => {
  it('requires an @', () => {
    assert.equal(isAddressed('reviewer how are the tests', 'reviewer'), false);
    assert.equal(isAddressed('@reviewer how are the tests', 'reviewer'), true);
  });

  it('is case-insensitive', () => {
    assert.equal(isAddressed('@Reviewer', 'reviewer'), true);
    assert.equal(isAddressed('@reviewer', 'Reviewer'), true);
  });

  it('does not fire on a bare name inside a sentence', () => {
    // The whole reason for the sigil: "the reviewer said no" is about the
    // reviewer, not to them.
    assert.equal(isAddressed('the reviewer said no', 'reviewer'), false);
  });

  it('ignores an @ inside a word, like a pasted identifier', () => {
    assert.equal(isAddressed('find me at josh@quintal.sh', 'quintal'), false);
    assert.equal(isAddressed('npub1w0rd@relay.example', 'relay'), false);
  });

  it('collects every distinct name addressed', () => {
    assert.deepEqual(mentionedNames('@a and @b and @a again'), ['a', 'b']);
  });

  it('reaches a person called by their truncated key, ellipsis and all', () => {
    const me = 'npub1rww4uhaw…nlarug';
    assert.equal(isAddressed('hey @npub1rww4uhaw…nlarug look', me), true);
    assert.equal(isAddressed('hey @NPUB1RWW4UHAW…NLARUG', me), true, 'any case');
    assert.equal(isAddressed('hey @npub1rww4uhaw', me), false, 'the whole name, not a prefix');
    assert.equal(isAddressed('hey @npub1rww4uhaw…nlarugs', me), false, 'and not one letter more');
  });

  it('reaches a name with a space in it, and the longest name that fits', () => {
    const names = ['Josh', 'Josh Silva', 'Ana'];
    assert.deepEqual(addressedNames('@Josh Silva, can you look? @Ana too', names), ['Josh Silva', 'Ana']);
    assert.deepEqual(addressedNames('@Josh can you look?', names), ['Josh']);
    assert.deepEqual(addressedNames('@Josh Silvas is somebody else', names), ['Josh']);
  });

  it('is still an @ at a word boundary, and nothing else', () => {
    assert.deepEqual(addressedNames('josh@quintal.sh', ['quintal', 'quintal.sh']), []);
    assert.deepEqual(addressedNames('email @ana now', ['ana']), ['ana']);
    assert.deepEqual(addressedNames('@ana@ana', ['ana']), ['ana'], 'once, and the second is inside a word');
    assert.deepEqual(addressedNames('nobody here', ['ana']), []);
    assert.deepEqual(addressedNames('@ana', ['', '  ']), [], 'a blank name matches nothing');
  });
});

describe('mention autocomplete', () => {
  it('finds the partial the caret sits in', () => {
    const query = mentionQueryAt('hey @rev', 8);
    assert.deepEqual(query, { query: 'rev', start: 4 });
  });

  it('offers everything right after a bare @', () => {
    assert.deepEqual(mentionQueryAt('@', 1), { query: '', start: 0 });
  });

  it('stays closed inside a pasted identifier', () => {
    assert.equal(mentionQueryAt('josh@quintal', 12), null);
  });

  it('keeps the whole partial, spaces and ellipses included, and ends at a line break', () => {
    // A finished mention followed by words stays a query; the picker closes
    // because nobody's name starts with it, not because of the space.
    assert.deepEqual(mentionQueryAt('@reviewer hello', 15), { query: 'reviewer hello', start: 0 });
    assert.deepEqual(mentionQueryAt('@npub1rww4uhaw…nl', 17), { query: 'npub1rww4uhaw…nl', start: 0 });
    assert.deepEqual(mentionQueryAt('@josh si', 8), { query: 'josh si', start: 0 });
    assert.equal(mentionQueryAt('@reviewer\nhello', 15), null);
  });

  it('inserts the full name and leaves the caret after it', () => {
    const result = applyMention('hey @rev', 4, 8, 'reviewer');
    assert.equal(result.text, 'hey @reviewer ');
    assert.equal(result.caret, result.text.length);
  });

  it('keeps whatever followed the caret', () => {
    const result = applyMention('@rev are you there', 0, 4, 'reviewer');
    assert.equal(result.text, '@reviewer  are you there');
  });
});
