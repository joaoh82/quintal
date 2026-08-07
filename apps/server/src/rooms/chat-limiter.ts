import { CHAT_RATE_LIMIT, CHAT_RATE_WINDOW_MS } from '@quintal/shared';

/**
 * Sliding-window rate limiter, one window per session.
 *
 * A fixed window would let someone send 2x the limit across a boundary; the
 * cost of doing it properly here is an array of at most `CHAT_RATE_LIMIT`
 * timestamps per player.
 */
export class ChatRateLimiter {
  readonly #windows = new Map<string, number[]>();

  constructor(
    private readonly limit: number = CHAT_RATE_LIMIT,
    private readonly windowMs: number = CHAT_RATE_WINDOW_MS,
  ) {}

  /** Records an attempt. False means "over the limit, drop this message". */
  tryConsume(sessionId: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.#windows.get(sessionId) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.limit) {
      this.#windows.set(sessionId, recent);
      return false;
    }

    recent.push(now);
    this.#windows.set(sessionId, recent);
    return true;
  }

  /** Seconds until the caller may send again. 0 if they may send now. */
  retryAfterSeconds(sessionId: string, now: number = Date.now()): number {
    const recent = this.#windows.get(sessionId) ?? [];
    if (recent.length < this.limit) return 0;
    const oldest = recent[0];
    if (oldest === undefined) return 0;
    return Math.max(0, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  forget(sessionId: string): void {
    this.#windows.delete(sessionId);
  }
}
