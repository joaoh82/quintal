import { idleStatus, type AgentScope, type BoardItemRef } from '@quintal/shared';

/**
 * The station's refusals: why a task cannot be begun at a desk for an
 * agent, in the words the asker reads. Pure, so each reason is pinned
 * without a room; the room gathers the facts and asks.
 */

/** One agent, as the station needs to know it. */
export interface StationAgent {
  name: string;
  /** Connected to the office now. */
  here: boolean;
  /** Its status line, as the nameplate shows it. */
  status: string;
  /** Holds a task, as its harness last said. */
  onTask: boolean;
  scopes: readonly AgentScope[];
}

/**
 * Why a task cannot be begun for this agent, or null when it can.
 *
 * It has to be here, because the chair is here. It has to be idle — the
 * status line empty — and on no task, because a desk given to a busy agent
 * would move it mid-turn; a standing refusal such as "no model … here" is
 * not work, but it is not an agent that would answer either. And it has to
 * be one the hand-over can reach and the desk can take: without `dm`
 * nothing wakes it, and without `move` it never walks. Any of these would
 * leave a note in "in progress" and a desk held, with nobody coming.
 */
export function whyNotBegin(agent: StationAgent): string | null {
  if (!agent.here) return `${agent.name} is not in the office.`;
  if (agent.onTask || !idleStatus(agent.status)) return `${agent.name} is on something already.`;
  if (!agent.scopes.includes('dm')) return `${agent.name} cannot be messaged, so nothing would wake it.`;
  if (!agent.scopes.includes('move')) return `${agent.name} may not move, so it could not walk to the desk.`;
  return null;
}

/** Why a picked note cannot be begun, or null: only an open note is there to pick. */
export function whyNotNote(item: Pick<BoardItemRef, 'status' | 'number'>): string | null {
  return item.status === 'open' ? null : `Note #${item.number} is not open.`;
}

/**
 * The note as the hand-over should see it before. A note already in this
 * agent's hands is handed to it again — the brief goes, so it begins — but
 * not *from* it: told "has gone to Arthur" in the same breath, Arthur would
 * read that the note left.
 */
export function handedFrom(before: BoardItemRef, agentId: string): BoardItemRef {
  return before.assignee?.id === agentId ? { ...before, assignee: null } : before;
}
