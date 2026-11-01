import { randomBytes } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import {
  isOfficeCommandName,
  isReservedCommandName,
  normaliseOfficeCommandArgumentHint,
  normaliseOfficeCommandInstructions,
  normaliseOfficeCommandName,
  normaliseOfficeCommandSummary,
  type OfficeCommandRef,
  type OfficeCommandTarget,
} from '../office-command.js';
import type { Database } from './client.js';
import { agents, officeCommands, teams, users } from './schema.js';

/**
 * The office's own `!` commands.
 *
 * One `office_commands` row each. The message path knows nothing of them
 * until a line is sent: the room reads `!review` against the list it keeps
 * from here and hands the instructions to the agents the line reaches. The
 * rules about who may do this are pure functions in `office-command.ts`.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

export class OfficeCommandError extends Error {
  constructor(
    readonly reason: 'invalid' | 'taken' | 'target',
    message: string,
  ) {
    super(message);
    this.name = 'OfficeCommandError';
  }
}

export interface OfficeCommandSummary {
  id: string;
  workspaceId: string;
  name: string;
  summary: string;
  argumentHint: string;
  instructions: string;
  /** Null when there is none, or the agent or team it named is gone. */
  defaultTarget: OfficeCommandTarget | null;
  createdBy: string | null;
  /** Who made it, as they are called now; empty when they have left. */
  createdByName: string;
  /** Who last wrote what it says; null until somebody has. Usually `createdBy`. */
  writtenBy: string | null;
  /** As they are called now; empty when nobody has, or they have left. */
  writtenByName: string;
  /** The agent that wrote it for `writtenBy`, if one did; null for a person's own hand. */
  writtenByAgentId: string | null;
  /** That agent, as it is called now; empty when none did, or it was deleted. */
  writtenByAgentName: string;
  createdAt: number;
  updatedAt: number;
}

/** What a client is told about a command. Instructions stay with the office and the agents. */
export function officeCommandRef(command: OfficeCommandSummary): OfficeCommandRef {
  return {
    id: command.id,
    name: command.name,
    summary: command.summary,
    argumentHint: command.argumentHint,
    defaultTarget: command.defaultTarget,
  };
}

/** Refuse a name that cannot be typed after `!`, is a built-in verb, or is another command's. */
async function assertNameFree(
  db: Database,
  workspaceId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  if (!isOfficeCommandName(name)) {
    throw new OfficeCommandError(
      'invalid',
      'A command name is one word — letters, digits, - or _ — because it is what people type after !.',
    );
  }
  if (isReservedCommandName(name)) {
    throw new OfficeCommandError('taken', `!${name} is built in; pick another name.`);
  }
  const rows = await db
    .select({ id: officeCommands.id })
    .from(officeCommands)
    .where(and(eq(officeCommands.workspaceId, workspaceId), eq(officeCommands.name, name)))
    .limit(1);
  if (rows[0] && rows[0].id !== exceptId) {
    throw new OfficeCommandError('taken', `There is already a !${name} here.`);
  }
}

export interface OfficeCommandTargetInput {
  kind: 'agent' | 'team';
  id: string;
}

/** The columns a default target is kept in, once it is known to be this office's. */
async function targetColumns(
  db: Database,
  workspaceId: string,
  target: OfficeCommandTargetInput | null,
): Promise<{ defaultAgentId: string | null; defaultTeamId: string | null }> {
  if (target === null) return { defaultAgentId: null, defaultTeamId: null };
  if (target.kind === 'agent') {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, target.id), eq(agents.workspaceId, workspaceId), isNull(agents.revokedAt)))
      .limit(1);
    if (!rows[0]) throw new OfficeCommandError('target', 'No such agent here, or it has been revoked.');
    return { defaultAgentId: target.id, defaultTeamId: null };
  }
  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, target.id), eq(teams.workspaceId, workspaceId)))
    .limit(1);
  if (!rows[0]) throw new OfficeCommandError('target', 'No such team here.');
  return { defaultAgentId: null, defaultTeamId: target.id };
}

export interface CreateOfficeCommandInput {
  workspaceId: string;
  name: string;
  summary?: string;
  argumentHint?: string;
  instructions?: string;
  defaultTarget?: OfficeCommandTargetInput | null;
  createdBy: string;
  /** The agent writing it on `createdBy`'s behalf, when one is. */
  writtenByAgentId?: string | null;
}

export async function createOfficeCommand(
  db: Database,
  input: CreateOfficeCommandInput,
): Promise<OfficeCommandSummary> {
  const name = normaliseOfficeCommandName(input.name);
  await assertNameFree(db, input.workspaceId, name);
  const target = await targetColumns(db, input.workspaceId, input.defaultTarget ?? null);

  const id = newId();
  await db.insert(officeCommands).values({
    id,
    workspaceId: input.workspaceId,
    name,
    summary: normaliseOfficeCommandSummary(input.summary),
    argumentHint: normaliseOfficeCommandArgumentHint(input.argumentHint),
    instructions: normaliseOfficeCommandInstructions(input.instructions),
    ...target,
    createdBy: input.createdBy,
    writtenBy: input.createdBy,
    writtenByAgentId: input.writtenByAgentId ?? null,
  });
  const made = await getOfficeCommand(db, input.workspaceId, id);
  if (!made) throw new Error('The command was not written.');
  return made;
}

export interface UpdateOfficeCommandInput {
  workspaceId: string;
  commandId: string;
  name?: string;
  summary?: string;
  argumentHint?: string;
  instructions?: string;
  /** Null clears it; absent leaves it. */
  defaultTarget?: OfficeCommandTargetInput | null;
  /**
   * Who is writing: the person answerable for the change, and the agent
   * doing it for them when one is (null for their own hand). Absent leaves
   * the attribution as it was, for a change that touches no words.
   */
  writtenBy?: { userId: string; agentId: string | null };
}

/** Change a command. Absent fields stay. */
export async function updateOfficeCommand(db: Database, input: UpdateOfficeCommandInput): Promise<void> {
  const patch: Partial<typeof officeCommands.$inferInsert> = { updatedAt: new Date() };
  if (input.writtenBy !== undefined) {
    patch.writtenBy = input.writtenBy.userId;
    patch.writtenByAgentId = input.writtenBy.agentId;
  }
  if (input.name !== undefined) {
    const name = normaliseOfficeCommandName(input.name);
    await assertNameFree(db, input.workspaceId, name, input.commandId);
    patch.name = name;
  }
  if (input.summary !== undefined) patch.summary = normaliseOfficeCommandSummary(input.summary);
  if (input.argumentHint !== undefined) {
    patch.argumentHint = normaliseOfficeCommandArgumentHint(input.argumentHint);
  }
  if (input.instructions !== undefined) {
    patch.instructions = normaliseOfficeCommandInstructions(input.instructions);
  }
  if (input.defaultTarget !== undefined) {
    Object.assign(patch, await targetColumns(db, input.workspaceId, input.defaultTarget));
  }
  await db
    .update(officeCommands)
    .set(patch)
    .where(and(eq(officeCommands.id, input.commandId), eq(officeCommands.workspaceId, input.workspaceId)));
}

export async function deleteOfficeCommand(
  db: Database,
  workspaceId: string,
  commandId: string,
): Promise<void> {
  await db
    .delete(officeCommands)
    .where(and(eq(officeCommands.id, commandId), eq(officeCommands.workspaceId, workspaceId)));
}

/** The agent that wrote a command, joined apart from the one it is aimed at; and the person it wrote for, apart from the maker. */
const authors = alias(agents, 'command_authors');
const writers = alias(users, 'command_writers');

function selectCommands(db: Database) {
  return (
    db
      .select({
        row: officeCommands,
        agentName: agents.name,
        teamName: teams.name,
        createdByName: users.name,
        writtenByName: writers.name,
        writtenByAgentName: authors.name,
      })
      .from(officeCommands)
      // A revoked agent keeps its row; a command aimed at it goes back to
      // having no default rather than reaching nobody.
      .leftJoin(
        agents,
        and(eq(agents.id, officeCommands.defaultAgentId), isNull(agents.revokedAt)),
      )
      .leftJoin(teams, eq(teams.id, officeCommands.defaultTeamId))
      .leftJoin(users, eq(users.id, officeCommands.createdBy))
      .leftJoin(writers, eq(writers.id, officeCommands.writtenBy))
      // Revoked or not: the brief it wrote is still the brief it wrote.
      .leftJoin(authors, eq(authors.id, officeCommands.writtenByAgentId))
  );
}

type CommandRow = Awaited<ReturnType<ReturnType<typeof selectCommands>['where']>>[number];

function summarise({ row, agentName, teamName, createdByName, writtenByName, writtenByAgentName }: CommandRow): OfficeCommandSummary {
  const defaultTarget: OfficeCommandTarget | null =
    row.defaultAgentId && agentName
      ? { kind: 'agent', id: row.defaultAgentId, name: agentName }
      : row.defaultTeamId && teamName
        ? { kind: 'team', id: row.defaultTeamId, name: teamName }
        : null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    summary: row.summary,
    argumentHint: row.argumentHint,
    instructions: row.instructions,
    defaultTarget,
    createdBy: row.createdBy,
    createdByName: createdByName ?? '',
    writtenBy: row.writtenBy,
    writtenByName: writtenByName ?? '',
    writtenByAgentId: row.writtenByAgentId,
    writtenByAgentName: writtenByAgentName ?? '',
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** Every command in an office, by name. */
export async function listOfficeCommandsForWorkspace(
  db: Database,
  workspaceId: string,
): Promise<OfficeCommandSummary[]> {
  const rows = await selectCommands(db)
    .where(eq(officeCommands.workspaceId, workspaceId))
    .orderBy(asc(officeCommands.name));
  return rows.map(summarise);
}

export async function getOfficeCommand(
  db: Database,
  workspaceId: string,
  commandId: string,
): Promise<OfficeCommandSummary | null> {
  const rows = await selectCommands(db)
    .where(and(eq(officeCommands.id, commandId), eq(officeCommands.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? summarise(rows[0]) : null;
}
