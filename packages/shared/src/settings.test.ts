import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OFFICE_SETTINGS,
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

  it('ignores an @ inside a word, like an email address', () => {
    assert.equal(isAddressed('mail me at josh@quintal.sh', 'quintal'), false);
  });

  it('collects every distinct name addressed', () => {
    assert.deepEqual(mentionedNames('@a and @b and @a again'), ['a', 'b']);
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

  it('stays closed inside an email address', () => {
    assert.equal(mentionQueryAt('josh@quintal', 12), null);
  });

  it('closes once the mention is finished', () => {
    assert.equal(mentionQueryAt('@reviewer hello', 15), null);
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
