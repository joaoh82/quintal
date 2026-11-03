import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import { AgentRosterError, createAgent, listAgentsForWorkspace, revokeAgent, setAgentName } from './agents.js';
import type { Database } from './client.js';
import * as schema from './schema.js';
import { createTestUser } from './testing.js';
import { MIGRATIONS_FOLDER } from './url.js';

/**
 * The rules on an office's agents, with requests overlapping.
 *
 * Over one file through two connections, because that is what they are up
 * against: two rooms of one office, and Settings in another process. Each
 * request has been let past its own look at the roster before it writes, so
 * only the write itself can hold the line.
 */
async function twoConnections(): Promise<[Database, Database]> {
  const url = `file:${join(mkdtempSync(join(tmpdir(), 'roster-')), 'q.db')}`;
  const first = drizzle(createClient({ url }), { schema }) as Database;
  await migrate(first, { migrationsFolder: MIGRATIONS_FOLDER });
  return [first, drizzle(createClient({ url }), { schema }) as Database];
}

function refusals(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
}

describe('an office\'s agents, with requests overlapping', () => {
  it('lets one of several creates have a name', async () => {
    const [a, b] = await twoConnections();
    const josh = await createTestUser(a, 'Josh');
    const make = (db: Database) =>
      createAgent(db, { workspaceId: josh.workspaceId, ownerUserId: josh.id, name: 'Bob', rules: {} });

    const results = await Promise.allSettled([make(a), make(b), make(a), make(b)]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const refused of refusals(results)) {
      assert.ok(refused instanceof AgentRosterError && refused.reason === 'name', String(refused));
    }
    assert.equal((await listAgentsForWorkspace(a, josh.workspaceId)).length, 1);
  });

  it('holds the ceiling on an owner\'s agents, counting them as it writes', async () => {
    const [a, b] = await twoConnections();
    const josh = await createTestUser(a, 'Josh');
    const make = (db: Database, name: string) =>
      createAgent(db, { workspaceId: josh.workspaceId, ownerUserId: josh.id, name, rules: { ownedMax: 3 } });
    await make(a, 'One');
    await make(a, 'Two');

    const results = await Promise.allSettled([make(a, 'Three'), make(b, 'Four'), make(a, 'Five'), make(b, 'Six')]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const refused of refusals(results)) {
      assert.ok(refused instanceof AgentRosterError && refused.reason === 'full', String(refused));
    }
    assert.equal((await listAgentsForWorkspace(a, josh.workspaceId)).length, 3);
  });

  it('lets one of several renames have a name, and a create racing them', async () => {
    const [a, b] = await twoConnections();
    const josh = await createTestUser(a, 'Josh');
    const base = { workspaceId: josh.workspaceId, ownerUserId: josh.id };
    const first = await createAgent(a, { ...base, name: 'First' });
    const second = await createAgent(a, { ...base, name: 'Second' });

    const results = await Promise.allSettled([
      setAgentName(a, first.id, 'Bob'),
      setAgentName(b, second.id, 'bob'),
      createAgent(b, { ...base, name: 'BOB', rules: {} }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const names = (await listAgentsForWorkspace(a, josh.workspaceId)).map((agent) => agent.name.toLowerCase());
    assert.equal(names.filter((name) => name === 'bob').length, 1);
  });
});

describe('a name in the office', () => {
  async function office() {
    const [db] = await twoConnections();
    const josh = await createTestUser(db, 'Josh');
    const base = { workspaceId: josh.workspaceId, ownerUserId: josh.id };
    return { db, josh, base };
  }

  it('is refused when an agent has it, any case, non-ASCII too', async () => {
    const { db, base } = await office();
    await createAgent(db, { ...base, name: 'Éva' });
    await assert.rejects(() => createAgent(db, { ...base, name: 'éva', rules: {} }), AgentRosterError);
  });

  it('is refused when a person here has it', async () => {
    const { db, base } = await office();
    await assert.rejects(() => createAgent(db, { ...base, name: 'josh', rules: {} }), AgentRosterError);
    const bob = await createAgent(db, { ...base, name: 'Bob' });
    await assert.rejects(() => setAgentName(db, bob.id, 'Josh'), AgentRosterError);
  });

  it('is free again once the agent that had it is revoked', async () => {
    const { db, base } = await office();
    const old = await createAgent(db, { ...base, name: 'Bob' });
    await revokeAgent(db, old.id, 'nobody');
    await createAgent(db, { ...base, name: 'Bob', rules: {} });
  });

  it('can change case on its own agent', async () => {
    const { db, base } = await office();
    const bob = await createAgent(db, { ...base, name: 'bob' });
    assert.equal(await setAgentName(db, bob.id, 'Bob'), 'Bob');
  });

  it('is not anybody\'s in another office', async () => {
    const { db, base } = await office();
    await createAgent(db, { ...base, name: 'Bob' });
    const ana = await createTestUser(db, 'Ana');
    await createAgent(db, { workspaceId: ana.workspaceId, ownerUserId: ana.id, name: 'Bob', rules: {} });
  });
});
