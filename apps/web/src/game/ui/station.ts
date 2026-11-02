import {
  idleStatus,
  type BoardAgentRef,
  type BoardItemRef,
  type BoardRoutineRef,
  type BoardRoutineRunRef,
  type MapInteractable,
  type RosterEntry,
} from '@quintal/shared';

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

/** The routines and their runs, as the board carries them, for telling a scheduled turn from any other. */
export interface Scheduled {
  routines: readonly BoardRoutineRef[];
  runs: readonly BoardRoutineRunRef[];
}

/**
 * How long after a routine's line is spoken its agent's turn may begin and
 * still be that routine's: the harness wakes within seconds, and a turn
 * that began minutes later is somebody else's question.
 */
export const ROUTINE_WAKE_WINDOW_MS = 3 * 60_000;

/**
 * The routine an agent is on, if its turn is one: the newest of its
 * routines' runs whose line was spoken just before the turn began. A
 * routine fires as a line in its owner's DM, and nothing in the turn names
 * it, so this is read off the clocks — the office's on both sides. Null
 * for a turn that is somebody's question, or for an agent on no turn.
 */
export function routineOn(entry: Pick<RosterEntry, 'identityId' | 'workingSince'>, scheduled: Scheduled): BoardRoutineRef | null {
  if (entry.workingSince <= 0) return null;
  const mine = new Map(scheduled.routines.filter((routine) => routine.agentId === entry.identityId).map((routine) => [routine.id, routine]));
  if (mine.size === 0) return null;
  let found: { routine: BoardRoutineRef; firedAt: number } | null = null;
  for (const run of scheduled.runs) {
    const routine = mine.get(run.routineId);
    if (!routine || run.firedAt === null) continue;
    if (run.firedAt > entry.workingSince || entry.workingSince - run.firedAt > ROUTINE_WAKE_WINDOW_MS) continue;
    if (!found || run.firedAt > found.firedAt) found = { routine, firedAt: run.firedAt };
  }
  return found?.routine ?? null;
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
export function candidates(roster: readonly RosterEntry[], you: string, scheduled?: Scheduled): Candidate[] {
  return roster
    .filter((entry) => entry.kind === 'agent' && entry.ownerUserId === you)
    .map((entry) => ({ entry, busy: whyBusy(entry, scheduled) }))
    .sort((a, b) => Number(a.busy.length > 0) - Number(b.busy.length > 0) || a.entry.name.localeCompare(b.entry.name));
}

function whyBusy(entry: RosterEntry, scheduled?: Scheduled): string {
  if (entry.task) return `on ${entry.task.title}`;
  // A scheduled turn is named for its routine, not for the tool it is on.
  const routine = scheduled ? routineOn(entry, scheduled) : null;
  if (routine) return `on its routine ${routine.name}`;
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
