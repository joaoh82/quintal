import { idleCapable, type BoardItemRef, type MapInteractable, type RosterEntry } from '@quintal/shared';

/**
 * The station: what an empty desk offers, and to whom.
 *
 * Pure, so the rules are pinned without a scene or a panel: who holds a
 * desk, which of your agents can be sent to one and why the others cannot,
 * which notes are there to pick from, and what the doorstep prompt says.
 */

/** Whoever the office has given the desk to, if they are here. */
export function holderOf(roster: readonly RosterEntry[], seatId: string): RosterEntry | null {
  return roster.find((entry) => entry.kind === 'agent' && entry.seat === seatId) ?? null;
}

/** One of your agents, as the station lists it: offered, or greyed with why not. */
export interface Candidate {
  entry: RosterEntry;
  /** Empty when the agent is free; otherwise what it is on, in a few words. */
  busy: string;
}

/**
 * Your agents that are in the office, free ones first. Free means idle and
 * on no task: a desk given to a busy agent would move it mid-turn. The rest
 * are listed, not offered, with the reason, so you can see why — an agent
 * that is not here is not listed at all, because nothing can be begun for
 * it from a chair it cannot walk to.
 */
export function candidates(roster: readonly RosterEntry[], you: string): Candidate[] {
  return roster
    .filter((entry) => entry.kind === 'agent' && entry.ownerUserId === you)
    .map((entry) => ({
      entry,
      busy: entry.task ? `on ${entry.task.title}` : idleCapable(entry.status) ? '' : entry.status,
    }))
    .sort((a, b) => Number(a.busy.length > 0) - Number(b.busy.length > 0) || a.entry.name.localeCompare(b.entry.name));
}

/**
 * The notes there are to pick from: open, and either nobody's or one of
 * your agents' already. A note in somebody else's agent's hands is theirs
 * to move. Newest first, as the board's own column reads.
 */
export function offeredNotes(items: readonly BoardItemRef[], yourAgentIds: ReadonlySet<string>): BoardItemRef[] {
  return items
    .filter((item) => item.status === 'open' && (!item.assignee || yourAgentIds.has(item.assignee.id)))
    .sort((a, b) => b.number - a.number);
}

/**
 * What E does where you stand, in words: the offer under the key. Null off
 * every doorstep.
 */
export function promptFor(near: MapInteractable | null, roster: readonly RosterEntry[]): string | null {
  if (!near) return null;
  if (near.kind === 'board') return `open ${near.label}`;
  const holder = holderOf(roster, near.id);
  return holder ? `see what ${holder.name} is on` : 'begin a task at this desk';
}
