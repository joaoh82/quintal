import { randomBytes } from 'node:crypto';

import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { displayName } from '../identity.js';
import {
  ROUTINES_PER_AGENT_MAX,
  describeRoutineSchedule,
  nextRoutineDue,
  normaliseRoutineArgs,
  normaliseRoutineInstructions,
  normaliseRoutineName,
  validateRoutineSchedule,
  type RoutineSchedule,
} from '../routine.js';
import type { Database } from './client.js';
import { agents, officeCommands, routineRuns, routines, users, type ROUTINE_RUN_OUTCOMES } from './schema.js';

/**
 * Routines and their runs.
 *
 * One `routines` row per standing request, one `routine_runs` row per slot
 * it was due. The room ticks, asks what is due, claims each slot by
 * inserting its run — the unique index refuses a second room — and speaks
 * the line. The rules about who may make one are pure functions in
 * `routine.ts`; here is what needs a database: the rows, the caps that
 * need a count, and that the agent and the command are this office's.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

export type RoutineRunOutcome = (typeof ROUTINE_RUN_OUTCOMES)[number];

export class RoutineError extends Error {
  constructor(
    readonly reason: 'invalid' | 'agent' | 'command' | 'full' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'RoutineError';
  }
}

export interface RoutineSummary {
  id: string;
  workspaceId: string;
  agentId: string;
  /** As it is called now. */
  agentName: string;
  agentOwnerUserId: string;
  name: string;
  schedule: RoutineSchedule;
  /** The schedule in words, zone included: "weekdays at 09:00 (Europe/Lisbon)". */
  scheduleLabel: string;
  instructions: string;
  /** The office command it runs, if one, as it is called now. Null when none, or it was deleted. */
  command: { id: string; name: string } | null;
  args: string;
  paused: boolean;
  /** When it next fires; null when paused, or a once routine that has had its moment. */
  nextDueAt: number | null;
  lastRunAt: number | null;
  createdBy: string | null;
  createdByName: string;
  createdByAgentId: string | null;
  createdByAgentName: string;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRunRef {
  id: string;
  routineId: string;
  dueAt: number;
  outcome: RoutineRunOutcome;
  note: string;
  firedAt: number | null;
  conversationId: string | null;
  createdAt: number;
}

/** The agent, if it is this office's and not revoked. */
async function agentHere(db: Database, workspaceId: string, agentId: string): Promise<{ id: string; ownerUserId: string }> {
  const rows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId), isNull(agents.revokedAt)))
    .limit(1);
  if (!rows[0]) throw new RoutineError('agent', 'No such agent here, or it has been revoked.');
  return rows[0];
}

/** The command's id, if it is this office's; null for none. */
async function commandHere(db: Database, workspaceId: string, commandId: string | null | undefined): Promise<string | null> {
  if (commandId === null || commandId === undefined || commandId.length === 0) return null;
  const rows = await db
    .select({ id: officeCommands.id })
    .from(officeCommands)
    .where(and(eq(officeCommands.id, commandId), eq(officeCommands.workspaceId, workspaceId)))
    .limit(1);
  if (!rows[0]) throw new RoutineError('command', 'No such command in this office.');
  return rows[0].id;
}

/**
 * Whether an agent already has a routine of this name, another than
 * `exceptId`. A name is how a routine is picked — by a person in Settings,
 * by an agent through the tools — so two on one agent would leave "stop
 * that" unable to choose, and a retried create would schedule the work
 * twice. Case does not tell them apart.
 */
async function nameTaken(db: Database, workspaceId: string, agentId: string, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await db
    .select({ id: routines.id })
    .from(routines)
    .where(
      and(
        eq(routines.workspaceId, workspaceId),
        eq(routines.agentId, agentId),
        sql`lower(${routines.name}) = lower(${name})`,
        ...(exceptId ? [sql`${routines.id} <> ${exceptId}`] : []),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function scheduleColumns(schedule: RoutineSchedule, after: number) {
  return {
    kind: schedule.kind,
    cron: schedule.kind === 'cron' ? schedule.cron : '',
    tz: schedule.tz,
    runAt: schedule.kind === 'once' ? new Date(schedule.at) : null,
    nextDueAt: toDate(nextRoutineDue(schedule, after)),
  };
}

function toDate(at: number | null): Date | null {
  return at === null ? null : new Date(at);
}

export interface CreateRoutineInput {
  workspaceId: string;
  agentId: string;
  name: string;
  schedule: RoutineSchedule;
  instructions?: string;
  commandId?: string | null;
  args?: string;
  createdBy: string;
  createdByAgentId?: string | null;
  /** The clock, for the first due moment. */
  now: number;
}

/**
 * Make a routine. The agent and the command must be this office's; the
 * schedule is checked again here, since a row is forever and a form is
 * not the only way in. At most `ROUTINES_PER_AGENT_MAX` per agent.
 */
export async function createRoutine(db: Database, input: CreateRoutineInput): Promise<RoutineSummary> {
  const name = normaliseRoutineName(input.name);
  if (name === null) throw new RoutineError('invalid', 'A routine needs a name, on one line.');
  const checked = validateRoutineSchedule(input.schedule);
  if (!checked.ok) throw new RoutineError('invalid', checked.error);
  const instructions = normaliseRoutineInstructions(input.instructions);
  const commandId = await commandHere(db, input.workspaceId, input.commandId);
  if (instructions.length === 0 && commandId === null) {
    throw new RoutineError('invalid', 'Say what the routine asks: instructions of its own, or a command to run.');
  }
  const agent = await agentHere(db, input.workspaceId, input.agentId);
  if (await nameTaken(db, input.workspaceId, agent.id, name, null)) {
    throw new RoutineError('invalid', `That agent already has a routine called "${name}"; change it, or pick another name.`);
  }
  const count = await db
    .select({ n: sql<number>`count(*)` })
    .from(routines)
    .where(and(eq(routines.workspaceId, input.workspaceId), eq(routines.agentId, agent.id)));
  if ((count[0]?.n ?? 0) >= ROUTINES_PER_AGENT_MAX) {
    throw new RoutineError('full', `An agent has at most ${ROUTINES_PER_AGENT_MAX} routines; take one off first.`);
  }
  const id = newId();
  await db.insert(routines).values({
    id,
    workspaceId: input.workspaceId,
    agentId: agent.id,
    name,
    ...scheduleColumns(checked.schedule, input.now),
    instructions,
    commandId,
    args: normaliseRoutineArgs(input.args),
    createdBy: input.createdBy,
    createdByAgentId: input.createdByAgentId ?? null,
  });
  const made = await getRoutine(db, input.workspaceId, id);
  if (!made) throw new Error('The routine was not written.');
  return made;
}

export interface UpdateRoutineInput {
  workspaceId: string;
  routineId: string;
  name?: string;
  schedule?: RoutineSchedule;
  instructions?: string;
  /** Null clears it; absent leaves it. */
  commandId?: string | null;
  args?: string;
  paused?: boolean;
  now: number;
}

/**
 * Change a routine. Absent fields stay. A new schedule, or a resume, sets
 * the next due moment from now; a pause clears it, so a paused routine is
 * never read as due.
 */
export async function updateRoutine(db: Database, input: UpdateRoutineInput): Promise<void> {
  const current = await getRoutine(db, input.workspaceId, input.routineId);
  if (!current) throw new RoutineError('not_found', 'No such routine.');
  const patch: Partial<typeof routines.$inferInsert> = { updatedAt: new Date(input.now) };
  if (input.name !== undefined) {
    const name = normaliseRoutineName(input.name);
    if (name === null) throw new RoutineError('invalid', 'A routine needs a name, on one line.');
    if (await nameTaken(db, input.workspaceId, current.agentId, name, current.id)) {
      throw new RoutineError('invalid', `That agent already has a routine called "${name}"; pick another name.`);
    }
    patch.name = name;
  }
  let schedule = current.schedule;
  if (input.schedule !== undefined) {
    const checked = validateRoutineSchedule(input.schedule);
    if (!checked.ok) throw new RoutineError('invalid', checked.error);
    schedule = checked.schedule;
    Object.assign(patch, scheduleColumns(schedule, input.now));
  }
  if (input.instructions !== undefined) patch.instructions = normaliseRoutineInstructions(input.instructions);
  if (input.commandId !== undefined) patch.commandId = await commandHere(db, input.workspaceId, input.commandId);
  if (input.args !== undefined) patch.args = normaliseRoutineArgs(input.args);
  const instructions = patch.instructions ?? current.instructions;
  const commandId = input.commandId !== undefined ? patch.commandId : current.command?.id ?? null;
  if (instructions.length === 0 && !commandId) {
    throw new RoutineError('invalid', 'Say what the routine asks: instructions of its own, or a command to run.');
  }
  if (input.paused !== undefined) patch.paused = input.paused;
  const paused = input.paused ?? current.paused;
  if (paused) patch.nextDueAt = null;
  else if (input.schedule !== undefined || input.paused === false) patch.nextDueAt = toDate(nextRoutineDue(schedule, input.now));
  await db
    .update(routines)
    .set(patch)
    .where(and(eq(routines.id, input.routineId), eq(routines.workspaceId, input.workspaceId)));
}

export async function deleteRoutine(db: Database, workspaceId: string, routineId: string): Promise<void> {
  await db.delete(routines).where(and(eq(routines.id, routineId), eq(routines.workspaceId, workspaceId)));
}

const makers = alias(agents, 'routine_makers');

function selectRoutines(db: Database) {
  return db
    .select({
      row: routines,
      agentName: agents.name,
      agentOwnerUserId: agents.ownerUserId,
      commandName: officeCommands.name,
      createdByName: users.name,
      createdByPubkey: users.pubkey,
      createdByAgentName: makers.name,
    })
    .from(routines)
    .innerJoin(agents, eq(agents.id, routines.agentId))
    .leftJoin(officeCommands, eq(officeCommands.id, routines.commandId))
    .leftJoin(users, eq(users.id, routines.createdBy))
    .leftJoin(makers, eq(makers.id, routines.createdByAgentId));
}

type RoutineRow = Awaited<ReturnType<ReturnType<typeof selectRoutines>['where']>>[number];

function summarise(entry: RoutineRow): RoutineSummary {
  const { row } = entry;
  const schedule: RoutineSchedule =
    row.kind === 'once'
      ? { kind: 'once', at: row.runAt?.getTime() ?? 0, tz: row.tz }
      : { kind: 'cron', cron: row.cron, tz: row.tz };
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    agentName: entry.agentName,
    agentOwnerUserId: entry.agentOwnerUserId,
    name: row.name,
    schedule,
    scheduleLabel: describeRoutineSchedule(schedule),
    instructions: row.instructions,
    command: row.commandId && entry.commandName ? { id: row.commandId, name: entry.commandName } : null,
    args: row.args,
    paused: row.paused,
    nextDueAt: row.nextDueAt?.getTime() ?? null,
    lastRunAt: row.lastRunAt?.getTime() ?? null,
    createdBy: row.createdBy,
    createdByName: row.createdBy ? displayName({ name: entry.createdByName, pubkey: entry.createdByPubkey ?? '' }) : '',
    createdByAgentId: row.createdByAgentId,
    createdByAgentName: entry.createdByAgentName ?? '',
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export async function getRoutine(db: Database, workspaceId: string, routineId: string): Promise<RoutineSummary | null> {
  const rows = await selectRoutines(db)
    .where(and(eq(routines.id, routineId), eq(routines.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? summarise(rows[0]) : null;
}

/** Every routine in an office, by agent then name. */
export async function listRoutinesForWorkspace(db: Database, workspaceId: string): Promise<RoutineSummary[]> {
  const rows = await selectRoutines(db)
    .where(eq(routines.workspaceId, workspaceId))
    .orderBy(asc(agents.name), asc(routines.name));
  return rows.map(summarise);
}

export async function listRoutinesForAgent(db: Database, workspaceId: string, agentId: string): Promise<RoutineSummary[]> {
  const rows = await selectRoutines(db)
    .where(and(eq(routines.workspaceId, workspaceId), eq(routines.agentId, agentId)))
    .orderBy(asc(routines.name));
  return rows.map(summarise);
}

/** The routines of an office due by `now`: not paused, with a due moment at or before it. */
export async function listDueRoutines(db: Database, workspaceId: string, now: number): Promise<RoutineSummary[]> {
  const rows = await selectRoutines(db)
    .where(
      and(
        eq(routines.workspaceId, workspaceId),
        eq(routines.paused, false),
        isNotNull(routines.nextDueAt),
        lte(routines.nextDueAt, new Date(now)),
      ),
    )
    .orderBy(asc(routines.nextDueAt));
  return rows.map(summarise);
}

export interface ClaimRoutineRunInput {
  routine: Pick<RoutineSummary, 'id' | 'workspaceId' | 'schedule'>;
  dueAt: number;
  /** `missed` until the line is spoken and the run settled; `skipped` is final. */
  outcome: 'missed' | 'skipped';
  note?: string;
}

/**
 * Take a slot: write its run and move the routine past it, in one
 * transaction. The insert is the lock — a second claim of the same (routine,
 * due moment) hits the unique index and gets null — and the advance moves
 * only a routine still standing at that slot, so the loser's leaves the
 * winner's alone. A slot to be spoken is written `missed` here and settled
 * when it is (`settleRoutineRun`): a room that stops in between leaves a
 * slot to be made up, not one recorded as fired. A once routine ends here,
 * its `nextDueAt` null.
 */
export async function claimRoutineRun(db: Database, input: ClaimRoutineRunInput): Promise<RoutineRunRef | null> {
  const { routine } = input;
  const next = nextRoutineDue(routine.schedule, input.dueAt);
  const [inserted] = await db.batch([
    db
      .insert(routineRuns)
      .values({
        id: newId(),
        routineId: routine.id,
        workspaceId: routine.workspaceId,
        dueAt: new Date(input.dueAt),
        outcome: input.outcome,
        note: input.note ?? '',
      })
      .onConflictDoNothing({ target: [routineRuns.routineId, routineRuns.dueAt] })
      .returning(),
    db
      .update(routines)
      .set({ nextDueAt: toDate(next) })
      .where(
        and(eq(routines.id, routine.id), eq(routines.workspaceId, routine.workspaceId), eq(routines.nextDueAt, new Date(input.dueAt))),
      ),
  ]);
  return inserted[0] ? runRef(inserted[0]) : null;
}

/**
 * Settle a run claimed as `missed`: spoken (`fired`, or `made_up` when its
 * slot had gone by) or `skipped` for good. Only a run still saying `missed`
 * is settled, and the caller speaks only when this says it won: two rooms
 * making up one slot both ask, and one gets it.
 */
export async function settleRoutineRun(
  db: Database,
  runId: string,
  outcome: { outcome: Exclude<RoutineRunOutcome, 'missed'>; note?: string; firedAt: number | null; conversationId: string | null },
): Promise<boolean> {
  const rows = await db
    .update(routineRuns)
    .set({ outcome: outcome.outcome, note: outcome.note ?? '', firedAt: toDate(outcome.firedAt), conversationId: outcome.conversationId })
    .where(and(eq(routineRuns.id, runId), eq(routineRuns.outcome, 'missed')))
    .returning({ id: routineRuns.id });
  return rows.length > 0;
}

/** Stamp when a routine last ran, leaving its next slot as it is: the claim already moved it. */
export async function markRoutineRan(db: Database, routine: Pick<RoutineSummary, 'id' | 'workspaceId'>, ranAt: number): Promise<void> {
  await db
    .update(routines)
    .set({ lastRunAt: new Date(ranAt) })
    .where(and(eq(routines.id, routine.id), eq(routines.workspaceId, routine.workspaceId)));
}

/**
 * The runs of an office still waiting to be made up: each routine's newest
 * slot, when that slot was missed. An older missed slot is superseded by
 * the one after it and is never made up — the hour it was for has gone
 * twice over.
 */
export async function missedRoutineRuns(db: Database, workspaceId: string): Promise<RoutineRunRef[]> {
  const rows = await db
    .select()
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.workspaceId, workspaceId),
        eq(routineRuns.outcome, 'missed'),
        eq(
          routineRuns.dueAt,
          sql`(select max(latest.due_at) from routine_runs as latest where latest.routine_id = ${routineRuns.routineId})`,
        ),
      ),
    )
    .orderBy(asc(routineRuns.dueAt));
  return rows.map(runRef);
}

/** The newest run of a routine still waiting to be made up, if any. */
export async function missedRoutineRun(db: Database, routineId: string): Promise<RoutineRunRef | null> {
  const rows = await db
    .select()
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), eq(routineRuns.outcome, 'missed')))
    .orderBy(desc(routineRuns.dueAt))
    .limit(1);
  const newest = rows[0] ? runRef(rows[0]) : null;
  if (!newest) return null;
  const later = await db
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(and(eq(routineRuns.routineId, routineId), sql`${routineRuns.dueAt} > ${new Date(newest.dueAt)}`))
    .limit(1);
  return later[0] ? null : newest;
}

/** A routine's runs, newest first. */
export async function listRoutineRuns(db: Database, routineId: string, limit = 20): Promise<RoutineRunRef[]> {
  const rows = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId))
    .orderBy(desc(routineRuns.dueAt))
    .limit(limit);
  return rows.map(runRef);
}

/** An office's runs, newest first, across its routines. */
export async function listRoutineRunsForWorkspace(db: Database, workspaceId: string, limit = 200): Promise<RoutineRunRef[]> {
  const rows = await db
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.workspaceId, workspaceId))
    .orderBy(desc(routineRuns.dueAt))
    .limit(limit);
  return rows.map(runRef);
}

function runRef(row: typeof routineRuns.$inferSelect): RoutineRunRef {
  return {
    id: row.id,
    routineId: row.routineId,
    dueAt: row.dueAt.getTime(),
    outcome: row.outcome,
    note: row.note,
    firedAt: row.firedAt?.getTime() ?? null,
    conversationId: row.conversationId,
    createdAt: row.createdAt.getTime(),
  };
}
