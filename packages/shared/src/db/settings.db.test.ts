import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { users } from './schema.js';
import {
  getOfficeSettings,
  hasInstanceAdmin,
  isInstanceAdmin,
  listInstanceAdmins,
  saveOfficeSettings,
  setInstanceAdmin,
} from './settings.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * The office's own name, and who may set it.
 *
 * Instance settings were writable by anyone with a session — a guest who
 * redeemed an invite link included. A chat radius changed under everybody is a
 * nuisance. A *public name* changed under everybody is what somebody reads
 * before they sign in, so the gate had to exist before the name did.
 */
describe('what this deployment calls itself', () => {
  it('is empty until somebody names it, and the address stands in', async () => {
    const db = await createTestDb();
    assert.equal((await getOfficeSettings(db)).name, '');
  });

  it('is kept, and contained like every other name', async () => {
    const db = await createTestDb();

    const saved = await saveOfficeSettings(db, { name: '  Rockflow  ' });
    assert.equal(saved.name, 'Rockflow');
    assert.equal((await getOfficeSettings(db)).name, 'Rockflow');

    // Drawn on a page shown to people who have not signed in, so a bidi
    // override here reaches further than most.
    const nasty = await saveOfficeSettings(db, { name: 'Rock‮flow\nInc' });
    assert.equal(nasty.name, 'Rock flow Inc');
  });

  it('does not disturb the other settings', async () => {
    const db = await createTestDb();
    await saveOfficeSettings(db, { chatRadiusTiles: 20 });
    await saveOfficeSettings(db, { name: 'Rockflow' });

    const settings = await getOfficeSettings(db);
    assert.equal(settings.chatRadiusTiles, 20, 'a rename is not a reset');
    assert.equal(settings.name, 'Rockflow');
  });
});

describe('who may change instance-wide settings', () => {
  it('is nobody until somebody is made one', async () => {
    const db = await createTestDb();
    const user = await createTestUser(db, 'Josh');

    // A flag, not a query. The version this replaces answered "are you the
    // earliest account?", which is not a fact about the instance — it moved
    // when accounts were deleted, and silently reassigned who was in charge
    // the first time somebody tidied up a test user.
    assert.equal(await isInstanceAdmin(db, user.id), false);
    assert.equal(await hasInstanceAdmin(db), false);
  });

  it('is whoever was granted it, and stays that way', async () => {
    const db = await createTestDb();
    const first = await createTestUser(db, 'Josh');
    const second = await createTestUser(db, 'Sam');

    await setInstanceAdmin(db, second.id, true);

    assert.equal(await isInstanceAdmin(db, second.id), true);
    assert.equal(await isInstanceAdmin(db, first.id), false, 'age is not authority');
  });

  /** The failure that prompted all of this. */
  it('does not move when an account is deleted', async () => {
    const db = await createTestDb();
    const earliest = await createTestUser(db, 'A stale test identity');
    const real = await createTestUser(db, 'Josh');
    await setInstanceAdmin(db, real.id, true);

    await db.delete(users).where(eq(users.id, earliest.id));

    assert.equal(
      await isInstanceAdmin(db, real.id),
      true,
      'tidying up an old account must not hand the instance to somebody else',
    );
  });

  it('can be taken away', async () => {
    const db = await createTestDb();
    const user = await createTestUser(db, 'Josh');
    await setInstanceAdmin(db, user.id, true);
    await setInstanceAdmin(db, user.id, false);

    assert.equal(await isInstanceAdmin(db, user.id), false);
    assert.equal(await hasInstanceAdmin(db), false, 'and then nobody is in charge');
  });

  it('lists everybody who has it', async () => {
    const db = await createTestDb();
    const first = await createTestUser(db, 'Josh');
    const second = await createTestUser(db, 'Sam');
    await setInstanceAdmin(db, first.id, true);
    await setInstanceAdmin(db, second.id, true);

    const admins = await listInstanceAdmins(db);
    assert.deepEqual(
      admins.map((admin) => admin.name),
      ['Josh', 'Sam'],
    );
  });
});
