import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import { getOfficeGithub, sealOfficeGithubTokens } from './github.js';
import * as schema from './schema.js';
import { officeGithub } from './schema.js';
import { createTestUser } from './testing.js';
import { MIGRATIONS_FOLDER } from './url.js';

/**
 * The plain-text token must be gone from the files a copied database is made
 * of, not only from the row a query sees. In memory there are no files, so
 * these run against a real one in WAL mode, as a server's is.
 */

process.env.BETTER_AUTH_SECRET = 'github-file-test-secret-at-least-thirty-two-chars';

async function fileDb(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-github-file-'));
  const path = join(dir, 'quintal.db');
  const client = createClient({ url: `file:${path}` });
  t.after(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await client.execute('PRAGMA journal_mode = WAL;');
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const owner = await createTestUser(db, 'Josh');
  // Unique, so a match in the files can only be this token.
  const token = `ghp_${randomBytes(18).toString('hex')}`;
  const filesWith = (value: string) =>
    [path, `${path}-wal`, `${path}-shm`].filter((file) => existsSync(file) && readFileSync(file).includes(Buffer.from(value)));
  return { client, db, owner, token, filesWith, onDisk: () => filesWith(token) };
}

for (const where of ['database file', 'WAL'] as const) {
  describe(`a plain-text token in the ${where}`, () => {
    it('is gone from every file once the boot pass seals it', async (t) => {
      const { client, db, owner, token, onDisk } = await fileDb(t);
      await db.insert(officeGithub).values({ workspaceId: owner.workspaceId, token, login: 'josh', setByUserId: owner.id, createdAt: new Date(), updatedAt: new Date() });
      if (where === 'database file') await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      assert.notDeepEqual(onDisk(), [], 'the fixture really has it on disk');

      assert.deepEqual(await sealOfficeGithubTokens(db), { sealed: 1, unreadable: 0, scrubbed: true });
      assert.deepEqual(onDisk(), []);
      assert.equal((await getOfficeGithub(db, owner.workspaceId))?.token, token);
    });

    it('is gone from every file once a read seals it', async (t) => {
      const { client, db, owner, token, onDisk } = await fileDb(t);
      await db.insert(officeGithub).values({ workspaceId: owner.workspaceId, token, login: 'josh', setByUserId: owner.id, createdAt: new Date(), updatedAt: new Date() });
      if (where === 'database file') await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
      assert.notDeepEqual(onDisk(), []);

      assert.equal((await getOfficeGithub(db, owner.workspaceId))?.token, token);
      assert.deepEqual(onDisk(), []);
    });
  });
}

describe('plain-text tokens of several offices on one page', () => {
  // With more than one row on the page, a rewritten cell's old bytes are left
  // in its free space unless secure_delete zeroes them; one row hides that.
  it('are all gone from every file once the boot pass seals them', async (t) => {
    const { client, db, owner, filesWith } = await fileDb(t);
    const offices = [owner, ...(await Promise.all(Array.from({ length: 19 }, (_, i) => createTestUser(db, `Office ${i}`))))];
    const tokens = offices.map(() => `ghp_${randomBytes(18).toString('hex')}`);
    for (const [i, owner] of offices.entries()) {
      await db.insert(officeGithub).values({ workspaceId: owner.workspaceId, token: tokens[i]!, login: 'x', setByUserId: owner.id, createdAt: new Date(), updatedAt: new Date() });
    }
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    const leftOnDisk = () => tokens.filter((token) => filesWith(token).length > 0);
    assert.equal(leftOnDisk().length, tokens.length, 'the fixture really has them on disk');

    assert.deepEqual(await sealOfficeGithubTokens(db), { sealed: tokens.length, unreadable: 0, scrubbed: true });
    assert.deepEqual(leftOnDisk(), []);
  });
});
