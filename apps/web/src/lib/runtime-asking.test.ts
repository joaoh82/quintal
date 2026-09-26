import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RUN_SCOPE_WITHDRAWAL_NOTE,
  RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS,
} from '@quintal/shared';

import { askingCaveat, runWithdrawalNote } from './runtime-asking.js';

/**
 * The office may not imply it is gating tools on a runtime that has never
 * asked it anything. Three statuses, three different things to say, and the
 * distinction between the last two is the whole point: "we drove it and it
 * never asked" is a fact an owner must act on, "we have not established this"
 * is not.
 */

describe('what to say about a runtime that may never ask', () => {
  it('warns on a runtime driven end to end that never asked, and names its own settings file', () => {
    const caveat = askingCaveat('codex');
    assert.equal(caveat?.status, 'never_observed');
    assert.match(caveat?.headline ?? '', /never once asked Quintal/);
    // The file that actually governs it — the only control there is.
    assert.match(caveat?.externalGrants ?? '', /config\.toml/);
  });

  it('keeps the one-clause version shorter but no softer', () => {
    const caveat = askingCaveat('codex');
    // The office card has a few hundred pixels; the claim may not shrink with
    // the space.
    assert.ok((caveat?.summary.length ?? 0) < (caveat?.headline.length ?? 0));
    assert.match(caveat?.summary ?? '', /gates nothing/);
  });

  it('warns on opencode too', () => {
    assert.equal(askingCaveat('opencode')?.status, 'never_observed');
  });

  it('says something weaker, and differently, about a runtime nobody has measured', () => {
    const gemini = askingCaveat('gemini');
    assert.equal(gemini?.status, 'unknown');
    assert.match(gemini?.headline ?? '', /has not been established/);
    // Not the never-observed claim: we did not drive it and watch it stay silent.
    assert.doesNotMatch(gemini?.headline ?? '', /never/);
    assert.notEqual(gemini?.badge, askingCaveat('codex')?.badge);
  });

  it('treats an uninstalled runtime as unmeasured, not as silent', () => {
    assert.equal(askingCaveat('goose')?.status, 'unknown');
  });

  it('says nothing about a runtime that does ask', () => {
    assert.equal(askingCaveat('claude-code'), null);
    assert.equal(askingCaveat('omp'), null);
  });

  it('says nothing about a runtime it has never heard of, rather than crashing', () => {
    assert.equal(askingCaveat('something-else'), null);
  });

  it('says nothing about an agent the office does not define', () => {
    assert.equal(askingCaveat(null), null);
    assert.equal(askingCaveat(undefined), null);
    assert.equal(askingCaveat(''), null);
  });
});

describe('withdrawing run', () => {
  it('admits the withdrawal changes nothing observable on a runtime that never asks', () => {
    assert.equal(runWithdrawalNote('codex'), RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS);
    assert.match(runWithdrawalNote('opencode'), /Nothing observable changes/);
  });

  it('says what it has always said where the runtime does ask', () => {
    assert.equal(runWithdrawalNote('claude-code'), RUN_SCOPE_WITHDRAWAL_NOTE);
    assert.equal(runWithdrawalNote('omp'), RUN_SCOPE_WITHDRAWAL_NOTE);
  });

  it('keeps the general note for a runtime nobody has measured', () => {
    // Claiming the withdrawal changed nothing would be as unfounded as
    // claiming it changed everything.
    assert.equal(runWithdrawalNote('gemini'), RUN_SCOPE_WITHDRAWAL_NOTE);
    assert.equal(runWithdrawalNote(null), RUN_SCOPE_WITHDRAWAL_NOTE);
  });
});
