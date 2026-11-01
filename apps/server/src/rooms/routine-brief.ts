import { describeRoutineSchedule, officeCommandAuthorLabel, routineSlug, type AgentCommandCall } from '@quintal/shared';
import type { OfficeCommandSummary, RoutineSummary } from '@quintal/shared/db';

/**
 * What the office says when a routine fires, and how a due slot is decided.
 * Pure, so it is pinned without a room (`docs/ROUTINES.md`).
 *
 * A firing is a line from the routine's owner, in their DM with the agent,
 * naming it — the same shape as a board hand-over, so the same rules wake
 * the agent and keep the exchange, and the owner reads the run where they
 * set the routine up. The brief rides along as the hand-over's does, with a
 * `routine` on it so the harness heads it `[Routine …]`.
 */

/** How often a room asks what is due. A minute's cron is the floor's tenth; this is a quarter of that. */
export const ROUTINE_TICK_MS = 15_000;

/** The line the owner is seen to say in the DM. It names the agent, which is what reaches it. */
export function routineLine(routine: Pick<RoutineSummary, 'name' | 'agentName'>): string {
  return `@${routine.agentName} routine "${routine.name}" is due.`;
}

/**
 * What the agent is asked, attached to the line. A routine that runs a
 * command carries the command's brief first and its own words after, so a
 * `!review` routine reviews the way the office reviews and then does what
 * this routine adds. The heading says who set it up — the owner, via the
 * agent that made it for them when one did — the way a command's does.
 */
export function routineBrief(
  routine: RoutineSummary,
  command: Pick<OfficeCommandSummary, 'name' | 'instructions'> | null,
  dueAt: number,
): AgentCommandCall {
  const own = routine.instructions.trim();
  const instructions = command
    ? [command.instructions.trim(), own].filter((part) => part.length > 0).join('\n\n')
    : own;
  return {
    name: command ? command.name : routineSlug(routine.name),
    instructions,
    args: routine.args,
    definedBy: officeCommandAuthorLabel({
      createdBy: routine.createdBy,
      createdByName: routine.createdByName,
      writtenBy: routine.createdBy,
      writtenByName: routine.createdByName,
      writtenByAgentName: routine.createdByAgentName,
    }),
    addressed: true,
    routine: {
      name: routine.name,
      schedule: describeRoutineSchedule(routine.schedule),
      dueAt,
      tz: routine.schedule.tz,
    },
  };
}

/** What a due slot comes to, given where the agent is. */
export type RoutineDecision = { fire: true } | { fire: false; outcome: 'missed' | 'skipped'; note: string };

/**
 * A due slot fires when the agent is here and not still on the previous
 * run in this DM. Away, the slot is missed and may be made up when the
 * agent returns (`shouldMakeUp`). Still busy, it is skipped for good: the
 * routine is "do this every hour", not "queue one of these an hour".
 */
export function decideSlot(agent: { present: boolean; busyHere: boolean }): RoutineDecision {
  if (!agent.present) return { fire: false, outcome: 'missed', note: 'away' };
  if (agent.busyHere) return { fire: false, outcome: 'skipped', note: 'busy' };
  return { fire: true };
}

/**
 * Whether a missed slot is made up now: the agent is back and free, and the
 * routine's next slot has not come yet — if it has, that slot is the one
 * to fire, and the missed one is history. A once routine has no next slot,
 * so it is always made up on return.
 */
export function shouldMakeUp(input: {
  now: number;
  nextDueAt: number | null;
  agent: { present: boolean; busyHere: boolean };
}): boolean {
  if (!input.agent.present || input.agent.busyHere) return false;
  return input.nextDueAt === null || input.nextDueAt > input.now;
}
