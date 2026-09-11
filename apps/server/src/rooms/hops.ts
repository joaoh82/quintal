import { AGENT_MENTION_MAX_HOPS, type PlayerKind } from '@quintal/shared';

/**
 * How far a mention has travelled from agent to agent.
 *
 * A person's line is hop 0. An agent woken by a line at hop n posts at hop
 * n + 1. Past `AGENT_MENTION_MAX_HOPS` an agent's line is delivered and
 * shown like any other, but names nobody into a turn — that is the whole of
 * loop protection, and it has to be the office's rule, because a harness
 * that forgot it is exactly the one that loops.
 *
 * The office cannot see which line an agent is answering, so it remembers,
 * per agent and per conversation, the hop of the last line that woke it
 * there. Good enough: an agent answering in #engineering was woken in
 * #engineering, and a fresh human line there resets the count to zero.
 */

/** The key under which spatial wakes are remembered; channels use their id. */
export const SPATIAL = 'spatial';

export function hopOf(speakerKind: PlayerKind, wokenAtHop: number | undefined): number {
  if (speakerKind === 'human') return 0;
  return (wokenAtHop ?? 0) + 1;
}

/** Whether a line at this hop may still name anybody into a turn. `max` is the office's setting. */
export function mayWake(hop: number, max = AGENT_MENTION_MAX_HOPS): boolean {
  return hop <= max;
}

/** Per agent session, per conversation: the hop of the line that last woke it. */
export class WakeHops {
  readonly #byAgent = new Map<string, Map<string, number>>();

  woken(sessionId: string, conversation: string, hop: number): void {
    const mine = this.#byAgent.get(sessionId) ?? new Map<string, number>();
    mine.set(conversation, hop);
    this.#byAgent.set(sessionId, mine);
  }

  lastWake(sessionId: string, conversation: string): number | undefined {
    return this.#byAgent.get(sessionId)?.get(conversation);
  }

  forget(sessionId: string): void {
    this.#byAgent.delete(sessionId);
  }
}
