import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAgent, revokeAgent } from './agents.js';
import type { Database } from './client.js';
import { createOfficeCommand, deleteOfficeCommand } from './commands.js';
import {
  RoutineError,
  claimRoutineRun,
  createRoutine,
  deleteRoutine,
  getRoutine,
  listDueRoutines,
  listRoutineRuns,
  listRoutinesForAgent,
  listRoutinesForWorkspace,
  markRoutineRan,
  missedRoutineRun,
  missedRoutineRuns,
  settleRoutineRun,
  updateRoutine,
} from './routines.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * A routine is one agent, a schedule and a brief. What must hold: it is
 * this office's agent and this office's command, the next due moment is
 * kept on the row and moves past each slot, a slot is claimed once however
 * many ask, and a missed slot is found again to be made up.
 */

/** Sunday 1 Nov 2026, 12:00 Lisbon. */
const NOW = Date.UTC(2026, 10, 1, 12, 0);
const HOURLY = { kind: 'cron' as const, cron: '0 * * * *', tz: 'Europe/Lisbon' };

async function office(name: string) {
  const db = await createTestDb();
  const owner = await createTestUser(db, name);
  const agent = (agentName: string, ownerUserId = owner.id) =>
    createAgent(db, { workspaceId: owner.workspaceId, ownerUserId, name: agentName, spriteKey: 'slate' });
  return { db, owner, agent };
}

async function hourly(db: Database, workspaceId: string, agentId: string, createdBy: string, name = 'hourly PR check') {
  return createRoutine(db, {
    workspaceId,
    agentId,
    name,
    schedule: HOURLY,
    instructions: 'Review the open pull requests.',
    createdBy,
    now: NOW,
  });
}

describe('making a routine', () => {
  it('makes one on an agent of the office and says when it is next due', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    assert.equal(made.agentName, 'Marvin');
    assert.equal(made.agentOwnerUserId, owner.id);
    assert.equal(made.createdByName, 'Josh');
    assert.equal(made.scheduleLabel, 'every hour');
    assert.equal(made.nextDueAt, Date.UTC(2026, 10, 1, 13, 0));
    assert.equal(made.paused, false);
    assert.equal(made.command, null);
    assert.deepEqual(await listRoutinesForAgent(db, owner.workspaceId, marvin.id), [made]);
  });

  it('may run a command of the office instead of its own words, and loses it when the command goes', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const review = await createOfficeCommand(db, { workspaceId: owner.workspaceId, name: 'sweep', instructions: 'Read the diff.', createdBy: owner.id });
    const made = await createRoutine(db, {
      workspaceId: owner.workspaceId,
      agentId: marvin.id,
      name: 'morning review',
      schedule: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Lisbon' },
      commandId: review.id,
      args: 'whatever is open',
      createdBy: owner.id,
      now: NOW,
    });
    assert.deepEqual(made.command, { id: review.id, name: 'sweep' });
    assert.equal(made.scheduleLabel, 'weekdays at 09:00 (Europe/Lisbon)');
    await deleteOfficeCommand(db, owner.workspaceId, review.id);
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.command, null);
  });

  it('refuses another office’s agent, a revoked one, another office’s command, and nothing to ask', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const other = await createTestUser(db, 'Ana');
    const theirs = await createAgent(db, { workspaceId: other.workspaceId, ownerUserId: other.id, name: 'Theirs', spriteKey: 'slate' });
    await assert.rejects(hourly(db, owner.workspaceId, theirs.id, owner.id), (error: unknown) => error instanceof RoutineError && error.reason === 'agent');
    const theirCommand = await createOfficeCommand(db, { workspaceId: other.workspaceId, name: 'theirs', instructions: 'x', createdBy: other.id });
    await assert.rejects(
      createRoutine(db, { workspaceId: owner.workspaceId, agentId: marvin.id, name: 'x', schedule: HOURLY, commandId: theirCommand.id, createdBy: owner.id, now: NOW }),
      (error: unknown) => error instanceof RoutineError && error.reason === 'command',
    );
    await assert.rejects(
      createRoutine(db, { workspaceId: owner.workspaceId, agentId: marvin.id, name: 'x', schedule: HOURLY, createdBy: owner.id, now: NOW }),
      (error: unknown) => error instanceof RoutineError && error.reason === 'invalid' && /Say what/.test(error.message),
    );
    await revokeAgent(db, marvin.id, owner.id);
    await assert.rejects(hourly(db, owner.workspaceId, marvin.id, owner.id), (error: unknown) => error instanceof RoutineError && error.reason === 'agent');
  });

  it('refuses a schedule under the floor, and a twenty-first routine', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    await assert.rejects(
      createRoutine(db, { workspaceId: owner.workspaceId, agentId: marvin.id, name: 'x', schedule: { kind: 'cron', cron: '* * * * *', tz: 'UTC' }, instructions: 'x', createdBy: owner.id, now: NOW }),
      (error: unknown) => error instanceof RoutineError && error.reason === 'invalid' && /tighter/.test(error.message),
    );
    for (let i = 0; i < 20; i += 1) await hourly(db, owner.workspaceId, marvin.id, owner.id, `routine ${i}`);
    await assert.rejects(hourly(db, owner.workspaceId, marvin.id, owner.id, 'one more'), (error: unknown) => error instanceof RoutineError && error.reason === 'full');
  });

  it('refuses a second routine of one name on one agent, so a retried create schedules nothing twice', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const arthur = await agent('Arthur');
    const first = await hourly(db, owner.workspaceId, marvin.id, owner.id, 'hourly PR check');
    await assert.rejects(
      hourly(db, owner.workspaceId, marvin.id, owner.id, 'Hourly PR Check'),
      (error: unknown) => error instanceof RoutineError && error.reason === 'invalid' && /already has a routine called/.test(error.message),
    );
    const onArthur = await hourly(db, owner.workspaceId, arthur.id, owner.id, 'hourly PR check');
    assert.notEqual(onArthur.id, first.id, 'another agent may have one of the same name');
    const other = await hourly(db, owner.workspaceId, marvin.id, owner.id, 'daily digest');
    await assert.rejects(
      updateRoutine(db, { workspaceId: owner.workspaceId, routineId: other.id, name: 'hourly pr check', now: NOW }),
      (error: unknown) => error instanceof RoutineError && error.reason === 'invalid' && /already has a routine called/.test(error.message),
    );
    await updateRoutine(db, { workspaceId: owner.workspaceId, routineId: first.id, name: 'Hourly PR check', now: NOW });
    assert.equal((await getRoutine(db, owner.workspaceId, first.id))?.name, 'Hourly PR check', 'a routine may keep its own name, recased');
  });
});

describe('changing a routine', () => {
  it('changes what it is given; a pause clears the due moment and a resume sets it from now', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    await updateRoutine(db, { workspaceId: owner.workspaceId, routineId: made.id, name: 'PR sweep', paused: true, now: NOW });
    let after = (await getRoutine(db, owner.workspaceId, made.id))!;
    assert.equal(after.name, 'PR sweep');
    assert.equal(after.paused, true);
    assert.equal(after.nextDueAt, null);
    assert.equal(after.instructions, 'Review the open pull requests.');
    assert.deepEqual(await listDueRoutines(db, owner.workspaceId, NOW + 7_200_000), [], 'paused is never due');

    await updateRoutine(db, { workspaceId: owner.workspaceId, routineId: made.id, paused: false, now: NOW + 90_000 });
    after = (await getRoutine(db, owner.workspaceId, made.id))!;
    assert.equal(after.nextDueAt, Date.UTC(2026, 10, 1, 13, 0));

    await updateRoutine(db, { workspaceId: owner.workspaceId, routineId: made.id, schedule: { kind: 'once', at: NOW + 60_000, tz: 'UTC' }, now: NOW });
    after = (await getRoutine(db, owner.workspaceId, made.id))!;
    assert.equal(after.schedule.kind, 'once');
    assert.equal(after.nextDueAt, NOW + 60_000);
  });

  it('deletes only in its own office, and goes with its agent', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    await deleteRoutine(db, 'somewhere-else', made.id);
    assert.ok(await getRoutine(db, owner.workspaceId, made.id));
    await deleteRoutine(db, owner.workspaceId, made.id);
    assert.equal(await getRoutine(db, owner.workspaceId, made.id), null);
  });
});

describe('slots and runs', () => {
  it('lists what is due, claims a slot once, and moves the routine past it', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    const oneOClock = Date.UTC(2026, 10, 1, 13, 0);
    assert.deepEqual(await listDueRoutines(db, owner.workspaceId, oneOClock - 1), []);
    assert.deepEqual((await listDueRoutines(db, owner.workspaceId, oneOClock)).map((routine) => routine.id), [made.id]);

    const first = await claimRoutineRun(db, { routine: made, dueAt: oneOClock, outcome: 'missed' });
    assert.ok(first);
    assert.equal(first.outcome, 'missed', 'a slot says missed until it is spoken');
    const twoOClock = Date.UTC(2026, 10, 1, 14, 0);
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.nextDueAt, twoOClock, 'the claim moves the routine past the slot');
    assert.deepEqual(await listDueRoutines(db, owner.workspaceId, oneOClock), []);

    const second = await claimRoutineRun(db, { routine: made, dueAt: oneOClock, outcome: 'missed' });
    assert.equal(second, null, 'the second room loses the slot');
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.nextDueAt, twoOClock, 'and moves nothing');

    assert.equal(await settleRoutineRun(db, first.id, { outcome: 'fired', firedAt: oneOClock + 5, conversationId: null }), true);
    assert.equal(
      await settleRoutineRun(db, first.id, { outcome: 'made_up', firedAt: oneOClock + 9, conversationId: null }),
      false,
      'a slot is spoken once: the second settle loses',
    );
    await markRoutineRan(db, made, oneOClock + 5);
    const after = (await getRoutine(db, owner.workspaceId, made.id))!;
    assert.equal(after.nextDueAt, twoOClock);
    assert.equal(after.lastRunAt, oneOClock + 5);
    assert.deepEqual(
      (await listRoutineRuns(db, made.id)).map((run) => [run.outcome, run.firedAt, run.conversationId]),
      [['fired', oneOClock + 5, null]],
    );
  });

  it('a claim is one transaction: a routine no longer at the slot is left where it is', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    // The owner moved it to a daily routine between the room's read and its claim.
    await updateRoutine(db, {
      workspaceId: owner.workspaceId,
      routineId: made.id,
      schedule: { kind: 'cron', cron: '0 9 * * *', tz: 'Europe/Lisbon' },
      now: Date.UTC(2026, 10, 1, 12, 59),
    });
    const nineTomorrow = Date.UTC(2026, 10, 2, 9, 0);
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.nextDueAt, nineTomorrow);
    const stale = await claimRoutineRun(db, { routine: made, dueAt: Date.UTC(2026, 10, 1, 13, 0), outcome: 'missed' });
    assert.ok(stale, 'the stale slot is still written');
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.nextDueAt, nineTomorrow, 'but the routine is not moved off its new slot');
  });

  it('a once routine has its moment and no next', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await createRoutine(db, {
      workspaceId: owner.workspaceId,
      agentId: marvin.id,
      name: 'check the deploy',
      schedule: { kind: 'once', at: NOW + 3_600_000, tz: 'UTC' },
      instructions: 'Check it.',
      createdBy: owner.id,
      now: NOW,
    });
    assert.equal(made.nextDueAt, NOW + 3_600_000);
    assert.ok(await claimRoutineRun(db, { routine: made, dueAt: NOW + 3_600_000, outcome: 'missed' }));
    assert.equal((await getRoutine(db, owner.workspaceId, made.id))?.nextDueAt, null);
  });

  it('keeps a missed slot to be made up, and settles it when it is', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    const due = Date.UTC(2026, 10, 1, 13, 0);
    const missed = await claimRoutineRun(db, { routine: made, dueAt: due, outcome: 'missed', note: 'away' });
    assert.ok(missed);
    assert.equal((await missedRoutineRun(db, made.id))?.id, missed.id);
    assert.deepEqual((await missedRoutineRuns(db, owner.workspaceId)).map((run) => run.id), [missed.id]);
    assert.equal(await settleRoutineRun(db, missed.id, { outcome: 'made_up', firedAt: due + 600_000, conversationId: null }), true);
    assert.equal(
      await settleRoutineRun(db, missed.id, { outcome: 'made_up', firedAt: due + 600_001, conversationId: null }),
      false,
      'the other room asked too, and loses',
    );
    assert.equal(await missedRoutineRun(db, made.id), null);
    assert.deepEqual(await missedRoutineRuns(db, owner.workspaceId), []);
    assert.deepEqual((await listRoutineRuns(db, made.id)).map((run) => [run.outcome, run.firedAt]), [['made_up', due + 600_000]]);
    assert.equal((await listRoutinesForWorkspace(db, owner.workspaceId)).length, 1);
  });

  it('does not make up a missed slot once a later slot has come', async () => {
    const { db, owner, agent } = await office('Josh');
    const marvin = await agent('Marvin');
    const made = await hourly(db, owner.workspaceId, marvin.id, owner.id);
    const one = Date.UTC(2026, 10, 1, 13, 0);
    await claimRoutineRun(db, { routine: made, dueAt: one, outcome: 'missed' });
    await claimRoutineRun(db, { routine: made, dueAt: one + 3_600_000, outcome: 'skipped', note: 'busy' });
    assert.equal(await missedRoutineRun(db, made.id), null, 'the hour it was for has gone');
    assert.deepEqual(await missedRoutineRuns(db, owner.workspaceId), []);
    const again = await claimRoutineRun(db, { routine: made, dueAt: one + 7_200_000, outcome: 'missed' });
    assert.deepEqual((await missedRoutineRuns(db, owner.workspaceId)).map((run) => run.id), [again!.id]);
  });
});
