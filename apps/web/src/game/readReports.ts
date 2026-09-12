import { parseKey, type ConversationKey } from './conversationKey';

/**
 * What the office still has to be told about where you have read to.
 *
 * Separate from the store because the interesting part is not React: a
 * report that is due, has nowhere to go, and must still be due afterwards.
 * The office is the only copy that other machines can see, so a dropped
 * report is a dot left showing on a screen somebody else is looking at —
 * and the moment it is easiest to drop one is a reconnect, which is exactly
 * when the other screen is wrong.
 *
 * Channels and DMs only. A zone is not a place you catch up on, and nearby
 * is wherever you are standing.
 */

export interface ReadSink {
  markRead(channelId: string, at: number): void;
}

export class ReadReports {
  /** Cursors the office has been told, so the same one is not sent twice. */
  readonly #reported = new Map<ConversationKey, number>();
  /** Cursors waiting for the next flush. */
  readonly #pending = new Map<ConversationKey, number>();

  /**
   * Note everywhere this client has read to. Returns whether anything is now
   * waiting, so a caller can arm a timer only when there is a reason to.
   */
  queue(lastReadAt: Readonly<Record<ConversationKey, number>>): boolean {
    for (const [key, at] of Object.entries(lastReadAt)) {
      if (!parseKey(key).channelId) continue;
      if (at <= (this.#reported.get(key) ?? 0)) continue;
      if (at <= (this.#pending.get(key) ?? 0)) continue;
      this.#pending.set(key, at);
    }
    return this.#pending.size > 0;
  }

  /**
   * Send what is waiting, if there is anywhere to send it.
   *
   * Returns whether anything is still waiting afterwards — true when there
   * was no office to tell, so the caller comes back rather than forgetting.
   * A cursor counts as reported only once it has actually gone: marking one
   * sent that was never sent is a cursor nothing will ever send again.
   */
  flush(sink: ReadSink | null): boolean {
    if (!sink) return this.#pending.size > 0;
    for (const [key, at] of this.#pending) {
      const { channelId } = parseKey(key);
      if (channelId) {
        sink.markRead(channelId, at);
        this.#reported.set(key, at);
      }
      this.#pending.delete(key);
    }
    return false;
  }

  /** How many conversations are waiting to be reported. For tests. */
  get waiting(): number {
    return this.#pending.size;
  }
}
