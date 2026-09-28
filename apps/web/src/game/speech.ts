import { speechBubble, type PublicActivity } from '@quintal/shared';

/**
 * Lines an agent has said out loud, taken from its public activity.
 *
 * Agents used to speak through the same path as people, and the office drew a
 * bubble over whoever spoke. Since the activity stream landed, a turn's lines
 * go into the conversation as activity items instead — saying them again would
 * post everything twice — and the bubble went with them. That left an agent
 * answering a question in a room with nothing to show for it, which is most of
 * what makes an agent a visible teammate rather than a row in a list.
 *
 * So the bubble is drawn from the activity rather than from a second message.
 * The office has already decided who can hear it: `nearby` is set per client
 * from earshot, and only for spatial turns — a review posted in a channel is a
 * transcript, not something shouted across the floor.
 */
export class Speech {
  /** Item ids already spoken, or already there when we first heard this turn. */
  readonly #spoken = new Map<string, Set<string>>();

  /**
   * The line to put over the agent's head for this update, if any.
   *
   * An activity arrives many times as it streams, so only items that finished
   * since the last update count — and only the newest of them, because two
   * bubbles cannot occupy one head.
   *
   * The first update we hear for a turn is treated as history: whatever it
   * already carries was said before we were listening. That is what keeps a
   * reconnect, or walking into earshot halfway through, from replaying a
   * minute of somebody else's conversation as if it were happening now. It
   * also needs no clocks, which is the other reason to do it this way: the
   * harness, the office and the browser do not share one.
   */
  next(activity: PublicActivity): { agentId: string; text: string } | null {
    if (!activity.nearby || activity.channelId) return null;

    const finished = activity.items.filter(
      (item) => item.kind === 'message' && item.state === 'success' && item.text.trim().length > 0,
    );

    let spoken = this.#spoken.get(activity.turnId);
    if (!spoken) {
      spoken = new Set(finished.map((item) => item.id));
      this.#remember(activity.turnId, spoken);
      return null;
    }

    let latest: string | null = null;
    for (const item of finished) {
      if (spoken.has(item.id)) continue;
      spoken.add(item.id);
      latest = item.text;
    }

    return latest === null ? null : { agentId: activity.agentId, text: speechBubble(latest) };
  }

  /** A turn is over; nothing more will be said in it. */
  forget(turnId: string): void {
    this.#spoken.delete(turnId);
  }

  /**
   * Bounded, because a turn that never reaches a terminal state — a harness
   * killed mid-answer — would otherwise be remembered for the life of the tab.
   */
  #remember(turnId: string, spoken: Set<string>): void {
    this.#spoken.set(turnId, spoken);
    while (this.#spoken.size > 64) {
      const oldest = this.#spoken.keys().next().value;
      if (oldest === undefined) break;
      this.#spoken.delete(oldest);
    }
  }
}
