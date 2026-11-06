import {
  activityTerminal,
  idleStatus,
  type BoardAgentRef,
  type BoardItemRef,
  type MapInteractable,
  type RosterEntry,
} from '@quintal/shared';

import type { ConversationKey, Transcript } from '../useConversations';
import { currentTurn } from './desk';

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
 * The routine an agent's running turn is, by name, or null: a turn a
 * routine's line started says so itself (`AgentActivity.routine`, from the
 * brief the line carried), and nothing else does — the line is spoken in
 * the owner's DM, and the status line says `working`. Read from the turn
 * this client holds for the agent, which it holds only if it may read the
 * conversation the turn is in; for the owner, who the station is for,
 * that is their own DM. A finished turn is nobody's routine any more.
 */
export function routineOn(transcripts: Record<ConversationKey, Transcript>, agentId: string): string | null {
  const turn = currentTurn(transcripts, agentId)?.activity;
  if (!turn || activityTerminal(turn.state)) return null;
  return turn.routine?.name ?? null;
}

/**
 * Your agents that are in the office, free ones first. Free means idle and
 * on no task — a desk given to a busy agent would move it mid-turn; a
 * standing refusal ("no model … here") is not work, but not an agent that
 * would answer either — and one the hand-over can wake and the desk can
 * take: with `dm`, or nothing reaches it, and with `move`, or it never
 * walks. The rest are listed, not offered, with the reason, so you can see
 * why; an agent that is not here is not listed at all, because nothing can
 * be begun for it from a chair it cannot walk to. The office refuses the
 * same ones (`whyNotBegin`), before it writes anything.
 */
export function candidates(
  roster: readonly RosterEntry[],
  you: string,
  transcripts: Record<ConversationKey, Transcript> = {},
): Candidate[] {
  return [...oneSessionEach(roster.filter((entry) => entry.kind === 'agent' && entry.ownerUserId === you)).values()]
    .map((entry) => ({ entry, busy: whyBusy(entry, transcripts) }))
    .sort((a, b) => Number(a.busy.length > 0) - Number(b.busy.length > 0) || a.entry.name.localeCompare(b.entry.name));
}

/**
 * One session per agent, by its id. An agent is on one socket at a time
 * but can be in the roster on two: a harness restarted without a clean
 * leave keeps its old session in reconnection grace, `away`, beside the
 * live one, until the grace runs out. The live one is the agent. The away
 * one is kept only when it is all there is, and then it says so, which is
 * not free.
 */
function oneSessionEach(entries: readonly RosterEntry[]): Map<string, RosterEntry> {
  const chosen = new Map<string, RosterEntry>();
  for (const entry of entries) {
    const held = chosen.get(entry.identityId);
    if (!held || (held.status === 'away' && entry.status !== 'away')) chosen.set(entry.identityId, entry);
  }
  return chosen;
}

function whyBusy(entry: RosterEntry, transcripts: Record<ConversationKey, Transcript>): string {
  if (entry.task) return `on ${entry.task.title}`;
  // A scheduled turn is named for its routine, not by its status line.
  const routine = routineOn(transcripts, entry.identityId);
  if (routine) return `on its routine ${routine}`;
  if (!idleStatus(entry.status)) return entry.status;
  if (!entry.scopes.includes('dm')) return 'cannot be messaged';
  if (!entry.scopes.includes('move')) return 'cannot walk';
  return '';
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
 * The checkouts on an agent's machine, as its harness last listed them: what
 * the station can offer as a repository. Empty when the machine has not
 * said, which is also what a guest sees.
 */
export function checkoutsOf(agents: readonly BoardAgentRef[], agentId: string): string[] {
  return agents.find((agent) => agent.id === agentId)?.checkouts ?? [];
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
