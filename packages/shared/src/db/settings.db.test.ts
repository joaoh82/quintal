import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getOfficeSettings, isInstanceOwner, saveOfficeSettings } from './settings.js';
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
  it('is the account that set the instance up', async () => {
    const db = await createTestDb();
    const first = await createTestUser(db, 'Josh');

    assert.equal(await isInstanceOwner(db, first.id), true);
  });

  it('is not everybody who signs in afterwards', async () => {
    const db = await createTestDb();
    const first = await createTestUser(db, 'Josh');
    const second = await createTestUser(db, 'Sam');

    assert.equal(await isInstanceOwner(db, first.id), true);
    assert.equal(
      await isInstanceOwner(db, second.id),
      false,
      'otherwise anybody could rename the office everyone arrives at',
    );
  });

  it('is nobody on an instance with no accounts', async () => {
    const db = await createTestDb();
    assert.equal(await isInstanceOwner(db, 'nobody'), false);
  });
});
