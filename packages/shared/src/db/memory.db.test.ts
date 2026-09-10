import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_CORE_MEMORY_SLUG } from '../agent.js';
import {
  MemoryConflictError,
  createAgent,
  editAgentMemoryAsOwner,
  getAgentMemory,
  listAgentEvents,
  listAgentMemorySlugs,
  memoryHash,
  setAgentMemory,
} from './agents.js';
import { createHostToken, findHostByToken, fleetForHost } from './host-tokens.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * An owner editing an agent's memory from the settings page.
 *
 * Three things have to be true: the edit lands (and an empty edit clears),
 * it is on the record, and a running agent finds out — which happens by the
 * fleet's profile fingerprint moving, the same way an instruction edit
 * restarts it. The agent's own writes must *not* move it, or an agent that
 * takes a note restarts itself.
 */

async function world() {
  const db = await createTestDb();
  const josh = await createTestUser(db, 'Josh');
  const agent = await createAgent(db, {
    workspaceId: josh.workspaceId,
    ownerUserId: josh.id,
    name: 'buzz',
    spriteKey: 'slate',
    launch: { runtimeId: 'claude-code', hostLabel: 'laptop' },
  });
  const token = await createHostToken(db, { workspaceId: josh.workspaceId, ownerUserId: josh.id, label: 'laptop' });
  const host = (await findHostByToken(db, token.token))!;
  const fingerprint = async () => (await fleetForHost(db, host, 'laptop'))[0]!.profile;
  return { db, josh, agent, fingerprint };
}

describe('an owner editing memory', () => {
  it('writes the slug, records it, and moves the fingerprint', async () => {
    const w = await world();
    const before = await w.fingerprint();

    await editAgentMemoryAsOwner(w.db, w.agent.id, w.josh.workspaceId, AGENT_CORE_MEMORY_SLUG, 'be terse\n', w.josh.id);

    assert.equal((await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, 'core'))?.content, 'be terse');
    assert.notEqual(await w.fingerprint(), before, 'the host restarts the agent to read it');
    const events = await listAgentEvents(w.db, w.agent.id, w.josh.workspaceId, { kind: 'agent.memory_edited' });
    assert.equal(events.events.length, 1);
    assert.deepEqual(events.events[0]?.payload, {
      slug: 'core',
      bytes: 8,
      cleared: false,
      editedByUserId: w.josh.id,
    });
  });

  it('clears a slug when saved empty', async () => {
    const w = await world();
    await setAgentMemory(w.db, w.agent.id, 'auth-refactor', 'the auth refactor shipped');
    await editAgentMemoryAsOwner(w.db, w.agent.id, w.josh.workspaceId, 'auth-refactor', '   ', w.josh.id);
    assert.equal(await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, 'auth-refactor'), null);
    assert.deepEqual(await listAgentMemorySlugs(w.db, w.agent.id, w.josh.workspaceId), []);
  });

  it("the agent's own writes do not move the fingerprint", async () => {
    const w = await world();
    const before = await w.fingerprint();
    await setAgentMemory(w.db, w.agent.id, AGENT_CORE_MEMORY_SLUG, 'focus: the auth refactor');
    assert.equal(await w.fingerprint(), before, 'a note the agent took is not a restart');
  });

  it('refuses a slug that is not one', async () => {
    const w = await world();
    await assert.rejects(editAgentMemoryAsOwner(w.db, w.agent.id, w.josh.workspaceId, 'Not A Slug!', 'x', w.josh.id));
  });
});

/**
 * Two sessions of one agent, each rewriting core from what it read.
 *
 * Without the check the second write silently erases the first — the agent
 * "remembers" whichever session happened to finish last. With it, the second
 * writer is told, reads again, and can merge.
 */
describe('memory written from several sessions', () => {
  it('lands a write whose expected hash still holds, and refuses one whose does not', async () => {
    const w = await world();
    const empty = await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, AGENT_CORE_MEMORY_SLUG);
    assert.equal(empty, null, 'nothing written yet');

    // Session A creates core, conditional on nobody having done so.
    const a = await setAgentMemory(w.db, w.agent.id, AGENT_CORE_MEMORY_SLUG, 'be terse', memoryHash(''));
    assert.equal(a.hash, memoryHash('be terse'));

    // Session B read core before A wrote, and tries to write from that.
    await assert.rejects(
      setAgentMemory(w.db, w.agent.id, AGENT_CORE_MEMORY_SLUG, 'answer in Portuguese', memoryHash('')),
      (error: unknown) =>
        error instanceof MemoryConflictError &&
        error.slug === AGENT_CORE_MEMORY_SLUG &&
        error.actualHash === a.hash,
    );
    assert.equal(
      (await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, AGENT_CORE_MEMORY_SLUG))?.content,
      'be terse',
      'the losing write changed nothing',
    );

    // B reads again, merges, and writes against what it now sees.
    const current = await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, AGENT_CORE_MEMORY_SLUG);
    const merged = await setAgentMemory(
      w.db,
      w.agent.id,
      AGENT_CORE_MEMORY_SLUG,
      `${current!.content}\nanswer in Portuguese`,
      current!.hash,
    );
    assert.equal(merged.bytes, Buffer.byteLength('be terse\nanswer in Portuguese'));
  });

  it('writes unconditionally when no hash is given, as it always did', async () => {
    const w = await world();
    await setAgentMemory(w.db, w.agent.id, AGENT_CORE_MEMORY_SLUG, 'one');
    await setAgentMemory(w.db, w.agent.id, AGENT_CORE_MEMORY_SLUG, 'two');
    const row = await getAgentMemory(w.db, w.agent.id, w.josh.workspaceId, AGENT_CORE_MEMORY_SLUG);
    assert.equal(row?.content, 'two');
    assert.equal(row?.hash, memoryHash('two'), 'every read carries the hash a write can be conditioned on');
  });
});
