import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISPLAY_NAME_MAX_LENGTH,
  PROFILE_DESCRIPTION_MAX_LENGTH,
  normaliseDisplayName,
  normaliseProfileDescription,
  personalWorkspaceName,
  slugify,
} from './workspace.js';

/**
 * Display names are self-asserted, so everything a person types here ends up
 * drawn over somebody's head and inside other people's rosters. These are
 * containment tests, not formatting tests.
 */

describe('normaliseDisplayName', () => {
  it('keeps an ordinary name', () => {
    assert.equal(normaliseDisplayName('  Josh  '), 'Josh');
    assert.equal(normaliseDisplayName('Ada Lovelace'), 'Ada Lovelace');
  });

  it('treats an empty or absent name as unset, not as a blank name', () => {
    assert.equal(normaliseDisplayName(''), null);
    assert.equal(normaliseDisplayName('   '), null);
    assert.equal(normaliseDisplayName(null), null);
    assert.equal(normaliseDisplayName(42), null);
  });

  it('collapses whitespace so a name cannot be padded into its own line', () => {
    assert.equal(normaliseDisplayName('a\n\n\nb'), 'a b');
    assert.equal(normaliseDisplayName('a\t\t b'), 'a b');
  });

  it('strips control characters and bidi overrides', () => {
    // A right-to-left override inside a nameplate reorders the text around it,
    // which is how one label reaches into another.
    assert.equal(normaliseDisplayName('Jo\u202Esh'), 'Jo sh');
    assert.equal(normaliseDisplayName('Jo\u0000sh'), 'Jo sh');
    assert.equal(normaliseDisplayName('Jo\u200Bsh'), 'Jo sh');
  });

  it('clamps length rather than trusting the form', () => {
    const long = 'x'.repeat(500);
    assert.equal(normaliseDisplayName(long)?.length, DISPLAY_NAME_MAX_LENGTH);
  });

  it('allows two people to choose the same name', () => {
    // Deliberate: the key identifies, the name only labels. If this ever starts
    // returning something unique, the model has quietly changed.
    assert.equal(normaliseDisplayName('Josh'), normaliseDisplayName('Josh'));
  });
});

describe('normaliseProfileDescription', () => {
  it('keeps a normal line and drops nothing useful', () => {
    assert.equal(
      normaliseProfileDescription('  Builds the office.  '),
      'Builds the office.',
    );
  });

  it('is empty rather than null when unset', () => {
    assert.equal(normaliseProfileDescription(''), '');
    assert.equal(normaliseProfileDescription(undefined), '');
  });

  it('clamps to its own, longer limit', () => {
    const long = 'y'.repeat(1000);
    assert.equal(
      normaliseProfileDescription(long).length,
      PROFILE_DESCRIPTION_MAX_LENGTH,
    );
    assert.ok(PROFILE_DESCRIPTION_MAX_LENGTH > DISPLAY_NAME_MAX_LENGTH);
  });

  it('flattens newlines, because the card is not a document', () => {
    assert.equal(normaliseProfileDescription('one\ntwo'), 'one two');
  });
});

describe('workspace naming still works off a display name', () => {
  it('names an office after whatever the person is called', () => {
    assert.equal(personalWorkspaceName('Josh'), "Josh's Office");
    assert.equal(personalWorkspaceName('Chris'), "Chris' Office");
  });

  it('slugifies a truncated npub into something usable', () => {
    assert.equal(slugify('npub1lf9emx9…k9frnz'), 'npub1lf9emx9-k9frnz');
  });
});
