import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAgent, revokeAgent } from './agents.js';
import {
  TeamNameError,
  addTeamMember,
  createTeam,
  deleteTeam,
  findTeam,
  listTeamsForWorkspace,
  removeTeamMember,
  setTeamMembers,
  teamRef,
  teamsForAgent,
  updateTeam,
} from './teams.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * A team is a word that means several agents. What must hold: the word
 * means one thing in its office (no team called what an agent or a person
 * is called, in any case), the members are real agents of that office and
 * only the live ones count, and dissolving a team costs the agents nothing.
 */

async function office(name: string) {
  const db = await createTestDb();
  const owner = await createTestUser(db, name);
  const agent = (agentName: string) =>
    createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: agentName,
      spriteKey: 'slate',
    });
  return { db, owner, agent };
}

describe('naming a team', () => {
  it('makes one, and reads it back with its members', async () => {
    const { db, owner, agent } = await office('Ana');
    const claude = await agent('Claude');
    const codex = await agent('Codex');

    const team = await createTeam(db, {
      workspaceId: owner.workspaceId,
      name: ' engineering ',
      description: 'Reviews and ships.',
      instructions: 'Claim work before starting it.',
      createdBy: owner.id,
    });
    await setTeamMembers(db, {
      workspaceId: owner.workspaceId,
      teamId: team.id,
      agentIds: [claude.id, codex.id],
      addedBy: owner.id,
    });

    const [listed] = await listTeamsForWorkspace(db, owner.workspaceId);
    assert.equal(listed?.name, 'engineering', 'trimmed');
    assert.deepEqual(listed?.members.map((m) => m.name).sort(), ['Claude', 'Codex']);
    assert.equal(listed?.instructions, 'Claim work before starting it.');
    assert.deepEqual(
      teamRef(listed!).members.map((m) => m.id).sort(),
      [claude.id, codex.id].sort(),
    );
  });

  it('refuses a name with a space in it: nobody could type it after @', async () => {
    const { db, owner } = await office('Ana');
    await assert.rejects(
      createTeam(db, { workspaceId: owner.workspaceId, name: 'front end', createdBy: owner.id }),
      (error: unknown) => error instanceof TeamNameError && error.reason === 'invalid',
    );
  });

  it("refuses an agent's name, in any case", async () => {
    const { db, owner, agent } = await office('Ana');
    await agent('Marvin');
    await assert.rejects(
      createTeam(db, { workspaceId: owner.workspaceId, name: 'marvin', createdBy: owner.id }),
      (error: unknown) => error instanceof TeamNameError && error.reason === 'taken',
    );
  });

  it("refuses a person's name, and another team's", async () => {
    const { db, owner } = await office('Ana');
    await assert.rejects(
      createTeam(db, { workspaceId: owner.workspaceId, name: 'Ana', createdBy: owner.id }),
      (error: unknown) => error instanceof TeamNameError && error.reason === 'taken',
    );
    await createTeam(db, { workspaceId: owner.workspaceId, name: 'design', createdBy: owner.id });
    await assert.rejects(
      createTeam(db, { workspaceId: owner.workspaceId, name: 'DESIGN', createdBy: owner.id }),
      (error: unknown) => error instanceof TeamNameError && error.reason === 'taken',
    );
  });

  it('lets two offices each have an engineering team', async () => {
    const { db, owner } = await office('Ana');
    const bo = await createTestUser(db, 'Bo');
    await createTeam(db, { workspaceId: owner.workspaceId, name: 'engineering', createdBy: owner.id });
    await createTeam(db, { workspaceId: bo.workspaceId, name: 'engineering', createdBy: bo.id });
    assert.equal((await listTeamsForWorkspace(db, bo.workspaceId)).length, 1);
  });

  it('renames, but not onto a name that is taken; its own name is fine', async () => {
    const { db, owner, agent } = await office('Ana');
    await agent('Marvin');
    const team = await createTeam(db, {
      workspaceId: owner.workspaceId,
      name: 'engineering',
      createdBy: owner.id,
    });
    await updateTeam(db, { workspaceId: owner.workspaceId, teamId: team.id, name: 'Engineering' });
    assert.equal((await findTeam(db, owner.workspaceId, team.id))?.name, 'Engineering');
    await assert.rejects(
      updateTeam(db, { workspaceId: owner.workspaceId, teamId: team.id, name: 'Marvin' }),
      TeamNameError,
    );
    await updateTeam(db, { workspaceId: owner.workspaceId, teamId: team.id, description: 'Ships.' });
    const after = await findTeam(db, owner.workspaceId, team.id);
    assert.equal(after?.description, 'Ships.');
    assert.equal(after?.name, 'Engineering', 'a description change leaves the name alone');
  });
});

describe('who is on a team', () => {
  it('replaces the set, keeps shared seats, and refuses a stranger', async () => {
    const { db, owner, agent } = await office('Ana');
    const bo = await createTestUser(db, 'Bo');
    const a = await agent('A');
    const b = await agent('B');
    const c = await agent('C');
    const theirs = await createAgent(db, {
      workspaceId: bo.workspaceId,
      ownerUserId: bo.id,
      name: 'Theirs',
      spriteKey: 'slate',
    });
    const team = await createTeam(db, { workspaceId: owner.workspaceId, name: 't', createdBy: owner.id });
    const set = (ids: string[]) =>
      setTeamMembers(db, { workspaceId: owner.workspaceId, teamId: team.id, agentIds: ids, addedBy: owner.id });

    await set([a.id, b.id]);
    await set([b.id, c.id]);
    const members = (await findTeam(db, owner.workspaceId, team.id))?.members.map((m) => m.id);
    assert.deepEqual(members?.sort(), [b.id, c.id].sort());

    await assert.rejects(set([b.id, theirs.id]), /agent here/);
    assert.deepEqual(
      (await findTeam(db, owner.workspaceId, team.id))?.members.map((m) => m.id).sort(),
      [b.id, c.id].sort(),
      'a refused set changes nothing',
    );
  });

  it('adds and removes one at a time, and tells an agent which teams it is on', async () => {
    const { db, owner, agent } = await office('Ana');
    const a = await agent('A');
    const t1 = await createTeam(db, { workspaceId: owner.workspaceId, name: 't1', createdBy: owner.id });
    const t2 = await createTeam(db, { workspaceId: owner.workspaceId, name: 't2', createdBy: owner.id });
    await addTeamMember(db, { workspaceId: owner.workspaceId, teamId: t1.id, agentId: a.id, addedBy: owner.id });
    await addTeamMember(db, { workspaceId: owner.workspaceId, teamId: t1.id, agentId: a.id, addedBy: owner.id });
    await addTeamMember(db, { workspaceId: owner.workspaceId, teamId: t2.id, agentId: a.id, addedBy: owner.id });
    assert.deepEqual((await teamsForAgent(db, a.id)).map((t) => t.name).sort(), ['t1', 't2']);

    await removeTeamMember(db, { teamId: t1.id, agentId: a.id });
    assert.deepEqual((await teamsForAgent(db, a.id)).map((t) => t.name), ['t2']);
  });

  it('drops a revoked agent from the roll without touching its row', async () => {
    const { db, owner, agent } = await office('Ana');
    const a = await agent('A');
    const b = await agent('B');
    const team = await createTeam(db, { workspaceId: owner.workspaceId, name: 't', createdBy: owner.id });
    await setTeamMembers(db, { workspaceId: owner.workspaceId, teamId: team.id, agentIds: [a.id, b.id], addedBy: owner.id });

    await revokeAgent(db, a.id, owner.id);

    assert.deepEqual((await findTeam(db, owner.workspaceId, team.id))?.members.map((m) => m.id), [b.id]);
  });

  it('dissolves a team and leaves the agents standing', async () => {
    const { db, owner, agent } = await office('Ana');
    const a = await agent('A');
    const team = await createTeam(db, { workspaceId: owner.workspaceId, name: 't', createdBy: owner.id });
    await setTeamMembers(db, { workspaceId: owner.workspaceId, teamId: team.id, agentIds: [a.id], addedBy: owner.id });

    await deleteTeam(db, owner.workspaceId, team.id);

    assert.equal(await findTeam(db, owner.workspaceId, team.id), null);
    assert.deepEqual(await teamsForAgent(db, a.id), []);
    const agentsLeft = await db.query.agents.findMany();
    assert.equal(agentsLeft.length, 1, 'the agent is still there');
  });
});
