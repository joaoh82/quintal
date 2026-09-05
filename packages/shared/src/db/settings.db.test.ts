import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import { users } from './schema.js';
import {
  getInstanceSettings,
  getOfficeSettings,
  hasInstanceAdmin,
  isInstanceAdmin,
  listInstanceAdmins,
  saveInstanceSettings,
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
    assert.equal((await getInstanceSettings(db)).name, '');
  });

  it('is kept, and contained like every other name', async () => {
    const db = await createTestDb();

    const saved = await saveInstanceSettings(db, { name: '  Rockflow  ' });
    assert.equal(saved.name, 'Rockflow');
    assert.equal((await getInstanceSettings(db)).name, 'Rockflow');

    // Drawn on a page shown to people who have not signed in, so a bidi
    // override here reaches further than most.
    const nasty = await saveInstanceSettings(db, { name: 'Rock\u202eflow\nInc' });
    assert.equal(nasty.name, 'Rock flow Inc');
  });
});

/**
 * How one office's room behaves.
 *
 * These used to sit in the same 'global' row as the deployment's name, so every
 * office on a deployment shared them: changing how far speech carried in your
 * office changed it in everybody's. An office is a workspace, and this is a
 * property of the office.
 */
describe('how an office works', () => {
  it('starts from defaults, without needing a row', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    // A missing row must mean defaults, never zeroes — an office where nobody
    // can hear anybody is worse than one nobody has tuned.
    const settings = await getOfficeSettings(db, josh.workspaceId);
    assert.equal(settings.chatRadiusTiles, 12);
    assert.equal(settings.walkUpRadiusTiles, 3);
    assert.equal(settings.replyWindowSeconds, 90);
    assert.equal(settings.idleLife, true);
  });

  it('keeps idle life off once an office turned it off', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    await saveOfficeSettings(db, josh.workspaceId, { idleLife: false });
    assert.equal((await getOfficeSettings(db, josh.workspaceId)).idleLife, false);
  });

  it('keeps what an office chose', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    await saveOfficeSettings(db, josh.workspaceId, { chatRadiusTiles: 20 });
    assert.equal((await getOfficeSettings(db, josh.workspaceId)).chatRadiusTiles, 20);
    // Saving one value must not reset the others.
    assert.equal((await getOfficeSettings(db, josh.workspaceId)).walkUpRadiusTiles, 3);
  });

  /** The whole point of the change. */
  it('does not leak into another office', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const other = await createTestUser(db, 'Sam');

    await saveOfficeSettings(db, josh.workspaceId, { chatRadiusTiles: 40 });

    assert.equal(
      (await getOfficeSettings(db, other.workspaceId)).chatRadiusTiles,
      12,
      "tuning your office must not reach into somebody else's",
    );
  });

  it('clamps what it is given, because a form is not the authority', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    // A chat radius of 10^9 is a denial-of-service on the room.
    const saved = await saveOfficeSettings(db, josh.workspaceId, {
      chatRadiusTiles: 1_000_000_000,
    });
    assert.equal(saved.chatRadiusTiles, 40);
  });

  /**
   * A partial save must not reset what it did not mention.
   *
   * `saveOfficeSettings` merges over the current row, and the action feeds it
   * the current value for any field the form omitted. Both halves matter: a
   * form that posts only one radius, or a crafted request that posts none,
   * must leave the rest of the office exactly as it was.
   */
  it('leaves untouched settings alone when only one is saved', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    await saveOfficeSettings(db, josh.workspaceId, {
      chatRadiusTiles: 30,
      walkUpRadiusTiles: 8,
      replyWindowSeconds: 120,
    });
    await saveOfficeSettings(db, josh.workspaceId, { chatRadiusTiles: 25 });

    const settings = await getOfficeSettings(db, josh.workspaceId);
    assert.equal(settings.chatRadiusTiles, 25);
    assert.equal(settings.walkUpRadiusTiles, 8, 'a partial save is not a reset');
    assert.equal(settings.replyWindowSeconds, 120, 'a partial save is not a reset');
  });

  it('answers with defaults when no office was named', async () => {
    const db = await createTestDb();
    assert.deepEqual(await getOfficeSettings(db, ''), {
      chatRadiusTiles: 12,
      walkUpRadiusTiles: 3,
      replyWindowSeconds: 90,
      idleLife: true,
    });
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
