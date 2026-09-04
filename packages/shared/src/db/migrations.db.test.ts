import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { eq, sql } from 'drizzle-orm';

import { generateSecretKey, getPublicKeyHex, npubEncode } from '../identity.js';
import { agents, users } from './schema.js';
import { createTestDb } from './testing.js';
import { MIGRATIONS_FOLDER } from './url.js';
import { ensurePersonalWorkspace } from './workspaces.js';

/**
 * Data migrations, run against rows shaped the way the old code left them.
 *
 * A schema migration announces its own failure — the column is there or it
 * isn't. A data migration is a `WHERE` clause making a judgement about rows
 * nobody can see any more, and the only thing that catches a predicate which
 * matches too much or too little is a test that builds those rows on purpose.
 *
 * The shipped `.sql` file is read and executed here rather than restated: a
 * test of a paraphrase proves nothing about what actually runs.
 */
async function runMigration(
  db: Awaited<ReturnType<typeof createTestDb>>,
  tag: string,
): Promise<void> {
  const file = path.join(MIGRATIONS_FOLDER, `${tag}.sql`);
  await db.run(sql.raw(await readFile(file, 'utf8')));
}

async function insertUser(
  db: Awaited<ReturnType<typeof createTestDb>>,
  name: string,
): Promise<{ id: string; pubkey: string }> {
  const id = randomBytes(8).toString('hex');
  const pubkey = getPublicKeyHex(generateSecretKey());
  await db.insert(users).values({ id, name, pubkey });
  return { id, pubkey };
}

async function nameOf(
  db: Awaited<ReturnType<typeof createTestDb>>,
  id: string,
): Promise<string> {
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, id));
  const row = rows[0];
  assert.ok(row, `no user ${id}`);
  return row.name;
}

describe('0011 — unfreezing display names', () => {
  it('blanks a name that was generated from the account key', async () => {
    const db = await createTestDb();
    // Exactly what sign-up used to write: the truncated npub, ellipsis and all.
    const { pubkey } = await insertUser(db, 'placeholder');
    const npub = npubEncode(pubkey);
    const generated = `${npub.slice(0, 13)}…${npub.slice(-6)}`;
    const legacy = await insertUser(db, generated);

    await runMigration(db, '0011_unfreeze_display_names');

    assert.equal(await nameOf(db, legacy.id), '');
  });

  it('leaves a name somebody chose alone', async () => {
    const db = await createTestDb();
    const josh = await insertUser(db, 'Josh');
    // The near-misses, each of which the predicate must not match: an npub
    // written out in full, and a name that merely mentions one.
    const full = await insertUser(db, npubEncode(getPublicKeyHex(generateSecretKey())));
    const mentions = await insertUser(db, 'npub collector');
    // An ellipsis on its own is not enough — plenty of names trail off.
    const trailing = await insertUser(db, 'Josh, but…');

    await runMigration(db, '0011_unfreeze_display_names');

    assert.equal(await nameOf(db, josh.id), 'Josh');
    assert.notEqual(await nameOf(db, full.id), '');
    assert.equal(await nameOf(db, mentions.id), 'npub collector');
    assert.equal(await nameOf(db, trailing.id), 'Josh, but…');
  });

  it('is safe to run twice', async () => {
    const db = await createTestDb();
    const josh = await insertUser(db, 'Josh');

    await runMigration(db, '0011_unfreeze_display_names');
    await runMigration(db, '0011_unfreeze_display_names');

    assert.equal(await nameOf(db, josh.id), 'Josh');
  });
});

describe('0018 — letting existing agents be messaged', () => {
  async function scopesOf(
    db: Awaited<ReturnType<typeof createTestDb>>,
    id: string,
  ): Promise<unknown> {
    const rows = await db.select({ scopes: agents.scopes }).from(agents).where(eq(agents.id, id));
    return rows[0]?.scopes;
  }

  async function insertAgent(
    db: Awaited<ReturnType<typeof createTestDb>>,
    scopes: string,
  ): Promise<string> {
    const owner = await insertUser(db, 'Owner');
    const id = randomBytes(8).toString('hex');
    // Raw SQL, deliberately: the column is typed as JSON and the whole point
    // is what the migration does to rows written before `dm` existed —
    // including a row that is not well-formed JSON at all.
    await db.run(
      sql`insert into agents (id, workspace_id, owner_user_id, name, sprite_key, api_key_hash, scopes)
          values (${id}, ${(await ensurePersonalWorkspace(db, { userId: owner.id, name: 'Owner', pubkey: owner.pubkey })).id},
                  ${owner.id}, 'Bot', 'slate', ${randomBytes(8).toString('hex')}, ${scopes})`,
    );
    return id;
  }

  it('adds dm to an agent that predates the scope, once', async () => {
    const db = await createTestDb();
    const old = await insertAgent(db, '["chat","move"]');
    const already = await insertAgent(db, '["chat","dm"]');

    await runMigration(db, '0018_agents_may_be_messaged');
    await runMigration(db, '0018_agents_may_be_messaged');

    assert.deepEqual(await scopesOf(db, old), ['chat', 'move', 'dm']);
    assert.deepEqual(await scopesOf(db, already), ['chat', 'dm'], 'not added twice');
  });

  it('leaves a malformed scopes column alone rather than inventing one', async () => {
    const db = await createTestDb();
    const broken = await insertAgent(db, 'not json');

    await runMigration(db, '0018_agents_may_be_messaged');

    const rows = await db.run(sql`select scopes from agents where id = ${broken}`);
    assert.equal(rows.rows[0]?.['scopes'], 'not json');
  });
});
