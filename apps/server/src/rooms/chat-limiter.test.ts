import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChatRateLimiter } from './chat-limiter.js';

describe('ChatRateLimiter', () => {
  it('allows exactly the limit inside one window', () => {
    const limiter = new ChatRateLimiter(3, 1000);
    assert.equal(limiter.tryConsume('a', 0), true);
    assert.equal(limiter.tryConsume('a', 10), true);
    assert.equal(limiter.tryConsume('a', 20), true);
    assert.equal(limiter.tryConsume('a', 30), false);
  });

  it('limits each session separately', () => {
    const limiter = new ChatRateLimiter(1, 1000);
    assert.equal(limiter.tryConsume('a', 0), true);
    assert.equal(limiter.tryConsume('b', 0), true, 'one loud player must not mute everyone else');
  });

  it('slides rather than resetting on a fixed boundary', () => {
    const limiter = new ChatRateLimiter(2, 1000);
    limiter.tryConsume('a', 0);
    limiter.tryConsume('a', 900);
    // A fixed window would reset at 1000 and allow a burst of 2 more here.
    assert.equal(limiter.tryConsume('a', 1001), true, 'the message from t=0 has aged out');
    assert.equal(limiter.tryConsume('a', 1002), false, 'the one from t=900 has not');
  });

  it('reports when the caller may speak again', () => {
    const limiter = new ChatRateLimiter(1, 10_000);
    limiter.tryConsume('a', 0);
    assert.equal(limiter.retryAfterSeconds('a', 0), 10);
    assert.equal(limiter.retryAfterSeconds('a', 5000), 5);
    assert.equal(limiter.retryAfterSeconds('a', 10_001), 0);
  });

  it('forgets a session that left', () => {
    const limiter = new ChatRateLimiter(1, 1000);
    limiter.tryConsume('a', 0);
    limiter.forget('a');
    assert.equal(limiter.tryConsume('a', 1), true);
  });
});
