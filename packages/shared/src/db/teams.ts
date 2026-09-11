import { randomBytes } from 'node:crypto';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  isMentionableTeamName,
  normaliseTeamDescription,
  normaliseTeamInstructions,
  normaliseTeamName,
  type TeamRef,
} from '../team.js';
import { listPeopleForWorkspace } from './channels.js';
import type { Database } from './client.js';
import { agents, teamMembers, teams } from './schema.js';

/**
 * Teams: a name for several agents at once.
 *
 * A `teams` row plus rows in `team_members`. The message path knows nothing
 * of teams until a mention is resolved: the room expands `@engineering` to
 * the members it finds here, and from then on it is three ordinary mentions.
 *
 * The one rule with teeth is the name. A mention resolves by name across
 * people, agents and teams together, so a team may not be called what any
 * of them is called, in any case — `@Marvin` has to mean one thing. The
 * rules about who may do this are pure functions in `team.ts`.
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

export class TeamNameError extends Error {
  constructor(
    readonly reason: 'invalid' | 'taken',
    message: string,
  ) {
    super(message);
    this.name = 'TeamNameError';
  }
}

export interface TeamMemberEntry {
  /** `agents.id`. */
  id: string;
  name: string;
  ownerUserId: string;
  addedBy: string;
}

export interface TeamSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** Members still in the office. A revoked agent keeps its row and loses its seat. */
  members: TeamMemberEntry[];
}

/** What a client is told about a team. */
export function teamRef(team: TeamSummary): TeamRef {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    members: team.members.map((member) => ({ id: member.id, name: member.name })),
  };
}

/**
 * Refuse a name that is not one mention token, or that already means
 * somebody in this office — another team, an agent, or a person.
 */
async function assertNameFree(
  db: Database,
  workspaceId: string,
  name: string,
  exceptTeamId?: string,
): Promise<void> {
  if (!isMentionableTeamName(name)) {
    throw new TeamNameError(
      'invalid',
      'A team name is one word — letters, digits, - or _ — because it is what people type after @.',
    );
  }
  const wanted = name.toLowerCase();

  const sameTeam = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(sql`lower(${teams.name})`, wanted)))
    .limit(1);
  const clash = sameTeam.find((row) => row.id !== exceptTeamId);
  if (clash) throw new TeamNameError('taken', `There is already a team called ${clash.name}.`);

  const sameAgent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        isNull(agents.revokedAt),
        eq(sql`lower(${agents.name})`, wanted),
      ),
    )
    .limit(1);
  if (sameAgent[0]) {
    throw new TeamNameError(
      'taken',
      `${sameAgent[0].name} is an agent here; a team cannot share a name with one.`,
    );
  }

  const person = (await listPeopleForWorkspace(db, workspaceId)).find(
    (row) => row.name.toLowerCase() === wanted,
  );
  if (person) {
    throw new TeamNameError(
      'taken',
      `${person.name} is a person here; a team cannot share a name with one.`,
    );
  }
}

export interface CreateTeamInput {
  workspaceId: string;
  name: string;
  description?: string;
  instructions?: string;
  createdBy: string;
}

export async function createTeam(db: Database, input: CreateTeamInput): Promise<TeamSummary> {
  const name = normaliseTeamName(input.name);
  await assertNameFree(db, input.workspaceId, name);

  const id = newId();
  await db.insert(teams).values({
    id,
    workspaceId: input.workspaceId,
    name,
    description: normaliseTeamDescription(input.description),
    instructions: normaliseTeamInstructions(input.instructions),
    createdBy: input.createdBy,
  });
  const made = await findTeam(db, input.workspaceId, id);
  if (!made) throw new Error('The team was not written.');
  return made;
}

export interface UpdateTeamInput {
  workspaceId: string;
  teamId: string;
  name?: string;
  description?: string;
  instructions?: string;
}

/** Change what a team is called or says about itself. Absent fields stay. */
export async function updateTeam(db: Database, input: UpdateTeamInput): Promise<void> {
  const patch: Partial<typeof teams.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = normaliseTeamName(input.name);
    await assertNameFree(db, input.workspaceId, name, input.teamId);
    patch.name = name;
  }
  if (input.description !== undefined) patch.description = normaliseTeamDescription(input.description);
  if (input.instructions !== undefined) {
    patch.instructions = normaliseTeamInstructions(input.instructions);
  }
  await db
    .update(teams)
    .set(patch)
    .where(and(eq(teams.id, input.teamId), eq(teams.workspaceId, input.workspaceId)));
}

/** Dissolve a team. Its agents are untouched; only the seats go. */
export async function deleteTeam(db: Database, workspaceId: string, teamId: string): Promise<void> {
  await db.delete(teams).where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)));
}

/**
 * The team, if it is this office's. Every write to a team's seats goes
 * through here, so a team id from another office is refused by the helper
 * and not only by whichever page happened to call it.
 */
async function assertTeamHere(db: Database, workspaceId: string, teamId: string): Promise<void> {
  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
    .limit(1);
  if (!rows[0]) throw new Error('No such team here.');
}

/** Agents of this office that are still live: the only ones that may take a seat. */
async function liveAgentsHere(
  db: Database,
  workspaceId: string,
  agentIds: readonly string[],
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        isNull(agents.revokedAt),
        inArray(agents.id, [...agentIds]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Make the team's members exactly these agents.
 *
 * Every id must be a live agent of the same office; anything else is
 * refused whole, so a stale picker cannot half-apply — a revoked agent
 * would take a seat and never show in it. Seats that stay keep their
 * `addedBy`; new ones are credited to whoever set the list.
 */
export async function setTeamMembers(
  db: Database,
  input: { workspaceId: string; teamId: string; agentIds: readonly string[]; addedBy: string },
): Promise<void> {
  await assertTeamHere(db, input.workspaceId, input.teamId);
  const wanted = [...new Set(input.agentIds)];
  const live = await liveAgentsHere(db, input.workspaceId, wanted);
  if (live.size !== wanted.length) throw new Error('Not every one of those is a live agent here.');

  const current = await db
    .select({ agentId: teamMembers.agentId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, input.teamId));
  const have = new Set(current.map((row) => row.agentId));
  const gone = [...have].filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !have.has(id));

  if (gone.length > 0) {
    await db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, input.teamId), inArray(teamMembers.agentId, gone)));
  }
  if (added.length > 0) {
    await db
      .insert(teamMembers)
      .values(added.map((agentId) => ({ teamId: input.teamId, agentId, addedBy: input.addedBy })))
      .onConflictDoNothing();
  }
  await db.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, input.teamId));
}

export async function addTeamMember(
  db: Database,
  input: { workspaceId: string; teamId: string; agentId: string; addedBy: string },
): Promise<void> {
  await assertTeamHere(db, input.workspaceId, input.teamId);
  const live = await liveAgentsHere(db, input.workspaceId, [input.agentId]);
  if (!live.has(input.agentId)) throw new Error('No such agent here, or it has been revoked.');
  await db
    .insert(teamMembers)
    .values({ teamId: input.teamId, agentId: input.agentId, addedBy: input.addedBy })
    .onConflictDoNothing();
  await db.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, input.teamId));
}

export async function removeTeamMember(
  db: Database,
  input: { workspaceId: string; teamId: string; agentId: string },
): Promise<void> {
  await assertTeamHere(db, input.workspaceId, input.teamId);
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, input.teamId), eq(teamMembers.agentId, input.agentId)));
  await db.update(teams).set({ updatedAt: new Date() }).where(eq(teams.id, input.teamId));
}

async function membersOf(
  db: Database,
  teamIds: readonly string[],
): Promise<Map<string, TeamMemberEntry[]>> {
  const byTeam = new Map<string, TeamMemberEntry[]>();
  if (teamIds.length === 0) return byTeam;
  const rows = await db
    .select({
      teamId: teamMembers.teamId,
      agentId: teamMembers.agentId,
      addedBy: teamMembers.addedBy,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
    })
    .from(teamMembers)
    // Inner join on a live agent: a revoked one keeps its row and loses its
    // seat, so a team never reads as three when only two can answer.
    .innerJoin(agents, and(eq(agents.id, teamMembers.agentId), isNull(agents.revokedAt)))
    .where(inArray(teamMembers.teamId, [...teamIds]))
    .orderBy(asc(teamMembers.addedAt), asc(teamMembers.agentId));
  for (const row of rows) {
    const list = byTeam.get(row.teamId) ?? [];
    list.push({ id: row.agentId, name: row.name, ownerUserId: row.ownerUserId, addedBy: row.addedBy });
    byTeam.set(row.teamId, list);
  }
  return byTeam;
}

async function hydrate(db: Database, rows: (typeof teams.$inferSelect)[]): Promise<TeamSummary[]> {
  const members = await membersOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    members: members.get(row.id) ?? [],
  }));
}

/** Every team in an office, oldest first, with members. */
export async function listTeamsForWorkspace(db: Database, workspaceId: string): Promise<TeamSummary[]> {
  const rows = await db
    .select()
    .from(teams)
    .where(eq(teams.workspaceId, workspaceId))
    .orderBy(asc(teams.createdAt), asc(teams.id));
  return hydrate(db, rows);
}

export async function findTeam(
  db: Database,
  workspaceId: string,
  teamId: string,
): Promise<TeamSummary | null> {
  const rows = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
    .limit(1);
  return (await hydrate(db, rows))[0] ?? null;
}

/** The teams one agent is on, for telling it so on connect. */
export async function teamsForAgent(db: Database, agentId: string): Promise<TeamSummary[]> {
  const seats = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.agentId, agentId));
  if (seats.length === 0) return [];
  const rows = await db
    .select()
    .from(teams)
    .where(
      inArray(
        teams.id,
        seats.map((seat) => seat.teamId),
      ),
    )
    .orderBy(asc(teams.createdAt), asc(teams.id));
  return hydrate(db, rows);
}
