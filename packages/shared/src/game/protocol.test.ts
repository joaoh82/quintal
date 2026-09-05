import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHANNEL_POST_MAX_LENGTH, CHAT_MAX_LENGTH, messageMaxLength } from './protocol.js';

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
