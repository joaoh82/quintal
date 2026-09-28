import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHANNEL_POST_MAX_LENGTH,
  CHAT_MAX_LENGTH,
  messageMaxLength,
  speechBubble,
} from './protocol.js';

/**
 * Two caps, one rule for choosing between them.
 *
 * Speech is a bubble and stays short. A channel post is a transcript entry
 * and may be a review, a plan or a stack trace. The server, the harness and
 * the input box all have to agree on which applies, so the decision is one
 * function and not three copies of an `if`.
 */
describe('how long a message may be', () => {
  it('keeps speech short', () => {
    assert.equal(messageMaxLength(), CHAT_MAX_LENGTH);
    assert.equal(messageMaxLength(undefined), CHAT_MAX_LENGTH);
    assert.equal(messageMaxLength(null), CHAT_MAX_LENGTH);
    assert.equal(messageMaxLength(''), CHAT_MAX_LENGTH);
  });

  it('lets a channel or DM post run long', () => {
    assert.equal(messageMaxLength('ch-1'), CHANNEL_POST_MAX_LENGTH);
    assert.ok(CHANNEL_POST_MAX_LENGTH > CHAT_MAX_LENGTH * 10);
  });
});

describe('cutting a line down to a speech bubble', () => {
  it('leaves a short line exactly as it was said', () => {
    assert.equal(speechBubble('On it.'), 'On it.');
    assert.equal(speechBubble('  spaced   out  '), 'spaced out');
  });

  it('never returns more than a bubble holds', () => {
    const long = 'The tree is not clean. '.repeat(40);
    assert.ok(speechBubble(long).length <= CHAT_MAX_LENGTH);
  });

  it('cuts at a sentence when it can, and says there is more', () => {
    const cut = speechBubble(`${'x'.repeat(100)}. ${'y'.repeat(300)}`);
    assert.equal(cut, `${'x'.repeat(100)}.…`);
  });

  /** `He said "stop."` ends where it looks like it ends, not before the quote. */
  it('keeps a closing quote with the sentence it closes', () => {
    const cut = speechBubble(`She said "stop." ${'y'.repeat(400)}`, 40);
    assert.equal(cut, 'She said "stop."…');
  });

  it('falls back to a word boundary when one sentence is too long', () => {
    const cut = speechBubble('alpha beta gamma delta epsilon zeta eta theta', 20);
    assert.ok(cut.endsWith('…'));
    assert.ok(!cut.includes('  '));
    assert.ok(cut.length <= 20);
    assert.ok('alpha beta gamma delta epsilon zeta eta theta'.startsWith(cut.slice(0, -1)));
  });

  it('cuts mid-word rather than returning nothing for one long token', () => {
    const cut = speechBubble('a'.repeat(400), 30);
    assert.equal(cut, `${'a'.repeat(29)}…`);
  });
});
