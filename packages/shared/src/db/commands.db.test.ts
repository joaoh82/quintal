import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import {
  isOfficeCommandName,
  isReservedCommandName,
  normaliseOfficeCommandArgumentHint,
  normaliseOfficeCommandInstructions,
  normaliseOfficeCommandName,
  normaliseOfficeCommandSummary,
  officeCommandAuthorLabel,
} from '../office-command.js';
import { createAgent, revokeAgent } from './agents.js';
import {
  OfficeCommandError,
  createOfficeCommand,
  deleteOfficeCommand,
  getOfficeCommand,
  listOfficeCommandsForWorkspace,
  officeCommandRef,
  updateOfficeCommand,
} from './commands.js';
import type { Database } from './client.js';
import { officeCommands } from './schema.js';
import { STARTER_OFFICE_COMMANDS } from './starter-commands.js';
import { createTeam, deleteTeam } from './teams.js';
import { createTestDb, createTestUser } from './testing.js';
import { ensurePersonalWorkspace } from './workspaces.js';

/**
 * An office command is a word and a brief. What must hold: the word means
 * one thing in its office and never a built-in verb, its default target is
 * one of this office's agents or teams, and that target going away leaves
 * the command reaching whoever the line names rather than nobody.
 */

/** Somebody with an office of their own, cleared of the commands it starts with. */
async function member(db: Database, name: string) {
  const user = await createTestUser(db, name);
  await db.delete(officeCommands).where(eq(officeCommands.workspaceId, user.workspaceId));
  return user;
}

async function office(name: string) {
  const db = await createTestDb();
  const owner = await member(db, name);
  const agent = (agentName: string) =>
    createAgent(db, {
      workspaceId: owner.workspaceId,
      ownerUserId: owner.id,
      name: agentName,
      spriteKey: 'slate',
    });
  return { db, owner, agent };
}

describe('making a command', () => {
  it('makes one, and reads it back with whoever made it', async () => {
    const { db, owner } = await office('Ana');
    const made = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: '!Review',
      summary: 'Review a pull request',
      argumentHint: '<pull request link>',
      instructions: 'Read the diff.\nSay what would break.',
      createdBy: owner.id,
    });

    assert.equal(made.name, 'review');
    assert.equal(made.instructions, 'Read the diff.\nSay what would break.');
    assert.equal(made.createdByName, 'Ana');
    assert.equal(made.defaultTarget, null);
    assert.deepEqual(officeCommandRef(made), {
      id: made.id,
      name: 'review',
      summary: 'Review a pull request',
      argumentHint: '<pull request link>',
      defaultTarget: null,
    });
    assert.deepEqual(
      (await listOfficeCommandsForWorkspace(db, owner.workspaceId)).map((c) => c.id),
      [made.id],
    );
  });

  it('refuses a built-in verb, a second command of the same name, and a name of two words', async () => {
    const { db, owner } = await office('Ana');
    const make = (name: string) =>
      createOfficeCommand(db, { workspaceId: owner.workspaceId, name, createdBy: owner.id });

    await assert.rejects(make('cancel'), (error: unknown) => {
      assert.ok(error instanceof OfficeCommandError);
      assert.equal(error.reason, 'taken');
      return true;
    });
    await make('review');
    await assert.rejects(make('REVIEW'), OfficeCommandError);
    await assert.rejects(make('code review'), OfficeCommandError);
  });

  it('lets two offices each have their own !review', async () => {
    const ana = await office('Ana');
    const bo = await member(ana.db, 'Bo');
    await createOfficeCommand(ana.db, { workspaceId: ana.owner.workspaceId, name: 'review', createdBy: ana.owner.id });
    await createOfficeCommand(ana.db, { workspaceId: bo.workspaceId, name: 'review', createdBy: bo.id });
  });
});

describe('a command an agent wrote', () => {
  it('is credited to its owner, via the agent, until a person saves it by hand', async () => {
    const { db, owner, agent } = await office('Ana');
    const marvin = await agent('Marvin');
    const made = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'triage',
      instructions: 'Read the open notes; say which you could take.',
      createdBy: owner.id,
      createdByAgentId: marvin.id,
    });
    assert.equal(made.createdByName, 'Ana');
    assert.equal(made.createdByAgentId, marvin.id);
    assert.equal(made.createdByAgentName, 'Marvin');
    assert.equal(officeCommandAuthorLabel(made), 'Ana, via Marvin');

    // Changed by another of Ana's agents: that one is now the "via".
    const arthur = await agent('Arthur');
    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: made.id, summary: 'Triage the board', changedByAgentId: arthur.id });
    assert.equal((await getOfficeCommand(db, owner.workspaceId, made.id))?.createdByAgentName, 'Arthur');

    // Saved by hand: Ana read what she saved, so it is hers alone again.
    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: made.id, summary: 'Triage', changedByAgentId: null });
    const byHand = await getOfficeCommand(db, owner.workspaceId, made.id);
    assert.equal(byHand?.createdByAgentId, null);
    assert.equal(officeCommandAuthorLabel(byHand!), 'Ana');

    // A change that says nothing about who made it leaves the credit alone.
    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: made.id, changedByAgentId: marvin.id });
    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: made.id, summary: 'Still triage' });
    assert.equal((await getOfficeCommand(db, owner.workspaceId, made.id))?.createdByAgentName, 'Marvin');
  });

  it('keeps the agent’s name on it after the agent is revoked', async () => {
    const { db, owner, agent } = await office('Ana');
    const marvin = await agent('Marvin');
    const made = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'triage',
      createdBy: owner.id,
      createdByAgentId: marvin.id,
    });
    await revokeAgent(db, marvin.id, owner.id);
    assert.equal((await getOfficeCommand(db, owner.workspaceId, made.id))?.createdByAgentName, 'Marvin');
  });
});

describe('a default target', () => {
  it('names an agent or a team as they are called now', async () => {
    const { db, owner, agent } = await office('Ana');
    const claude = await agent('Claude');
    const team = await createTeam(db, { workspaceId: owner.workspaceId, name: 'reviewers', createdBy: owner.id });

    const toAgent = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'tweet',
      defaultTarget: { kind: 'agent', id: claude.id },
      createdBy: owner.id,
    });
    assert.deepEqual(toAgent.defaultTarget, { kind: 'agent', id: claude.id, name: 'Claude' });

    const toTeam = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'review',
      defaultTarget: { kind: 'team', id: team.id },
      createdBy: owner.id,
    });
    assert.deepEqual(toTeam.defaultTarget, { kind: 'team', id: team.id, name: 'reviewers' });
  });

  it('must be this office’s', async () => {
    const ana = await office('Ana');
    const bo = await office('Bo');
    const theirs = await bo.agent('Codex');
    await assert.rejects(
      createOfficeCommand(ana.db, {
        workspaceId: ana.owner.workspaceId,
        name: 'review',
        defaultTarget: { kind: 'agent', id: theirs.id },
        createdBy: ana.owner.id,
      }),
      (error: unknown) => error instanceof OfficeCommandError && error.reason === 'target',
    );
  });

  it('goes when the agent is revoked or the team dissolved, and the command stays', async () => {
    const { db, owner, agent } = await office('Ana');
    const claude = await agent('Claude');
    const team = await createTeam(db, { workspaceId: owner.workspaceId, name: 'reviewers', createdBy: owner.id });
    const tweet = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'tweet',
      defaultTarget: { kind: 'agent', id: claude.id },
      createdBy: owner.id,
    });
    const review = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'review',
      defaultTarget: { kind: 'team', id: team.id },
      createdBy: owner.id,
    });

    await revokeAgent(db, claude.id, owner.id);
    await deleteTeam(db, owner.workspaceId, team.id);

    assert.equal((await getOfficeCommand(db, owner.workspaceId, tweet.id))?.defaultTarget, null);
    assert.equal((await getOfficeCommand(db, owner.workspaceId, review.id))?.defaultTarget, null);
  });
});

describe('changing a command', () => {
  it('changes what it is given and leaves the rest', async () => {
    const { db, owner, agent } = await office('Ana');
    const claude = await agent('Claude');
    const made = await createOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      name: 'review',
      summary: 'Review a PR',
      instructions: 'Be kind.',
      createdBy: owner.id,
    });

    await updateOfficeCommand(db, {
      workspaceId: owner.workspaceId,
      commandId: made.id,
      instructions: 'Be thorough.',
      defaultTarget: { kind: 'agent', id: claude.id },
    });
    let read = await getOfficeCommand(db, owner.workspaceId, made.id);
    assert.equal(read?.summary, 'Review a PR');
    assert.equal(read?.instructions, 'Be thorough.');
    assert.equal(read?.defaultTarget?.name, 'Claude');

    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: made.id, defaultTarget: null });
    read = await getOfficeCommand(db, owner.workspaceId, made.id);
    assert.equal(read?.defaultTarget, null);
  });

  it('may keep its own name but not take another’s', async () => {
    const { db, owner } = await office('Ana');
    const review = await createOfficeCommand(db, { workspaceId: owner.workspaceId, name: 'review', createdBy: owner.id });
    await createOfficeCommand(db, { workspaceId: owner.workspaceId, name: 'tweet', createdBy: owner.id });

    await updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: review.id, name: 'Review' });
    await assert.rejects(
      updateOfficeCommand(db, { workspaceId: owner.workspaceId, commandId: review.id, name: 'tweet' }),
      OfficeCommandError,
    );
  });

  it('deletes only in its own office', async () => {
    const ana = await office('Ana');
    const bo = await member(ana.db, 'Bo');
    const review = await createOfficeCommand(ana.db, {
      workspaceId: ana.owner.workspaceId,
      name: 'review',
      createdBy: ana.owner.id,
    });

    await deleteOfficeCommand(ana.db, bo.workspaceId, review.id);
    assert.ok(await getOfficeCommand(ana.db, ana.owner.workspaceId, review.id));
    await deleteOfficeCommand(ana.db, ana.owner.workspaceId, review.id);
    assert.equal(await getOfficeCommand(ana.db, ana.owner.workspaceId, review.id), null);
  });
});

describe('a new office', () => {
  it('starts with the starter commands, credited to nobody and aimed at nobody', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const commands = await listOfficeCommandsForWorkspace(db, ana.workspaceId);

    assert.deepEqual(
      commands.map((command) => command.name),
      STARTER_OFFICE_COMMANDS.map((command) => command.name).sort(),
    );
    const review = commands.find((command) => command.name === 'review');
    assert.ok(review);
    assert.equal(review.summary, 'Review a pull request');
    assert.equal(review.argumentHint, '<pull request link>');
    assert.match(review.instructions, /publish the review directly on the GitHub pull request/);
    assert.equal(review.defaultTarget, null);
    assert.equal(review.createdBy, null);
    assert.equal(review.createdByName, '');
  });

  it('keeps every starter intact under the limits a command is held to', async () => {
    for (const starter of STARTER_OFFICE_COMMANDS) {
      assert.equal(normaliseOfficeCommandName(starter.name), starter.name);
      assert.ok(isOfficeCommandName(starter.name) && !isReservedCommandName(starter.name));
      assert.equal(normaliseOfficeCommandSummary(starter.summary), starter.summary);
      assert.equal(normaliseOfficeCommandArgumentHint(starter.argumentHint), starter.argumentHint);
      assert.equal(normaliseOfficeCommandInstructions(starter.instructions), starter.instructions);
    }
  });

  it('does not bring a deleted one back on the next sign-in', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const [review] = await listOfficeCommandsForWorkspace(db, ana.workspaceId);
    assert.ok(review);
    await deleteOfficeCommand(db, ana.workspaceId, review.id);

    await ensurePersonalWorkspace(db, { userId: ana.id, name: 'Ana', pubkey: ana.pubkey });
    assert.deepEqual(await listOfficeCommandsForWorkspace(db, ana.workspaceId), []);
  });
});
