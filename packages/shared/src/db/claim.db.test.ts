import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { eq } from 'drizzle-orm';

import {
  checkClaimToken,
  claimUrl,
  mintClaimToken,
  parseClaimToken,
  redeemClaimToken,
  settleInstanceAdmin,
} from './claim.js';
import { instanceSettings } from './schema.js';
import { getInstanceSettings, isInstanceAdmin, listInstanceAdmins, saveInstanceSettings, setInstanceAdmin } from './settings.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * The claim link: how a fresh shared server gets somebody in charge without
 * handing it to whoever finds the sign-in page first (QUIN-87).
 */
describe('a claim link', () => {
  it('makes whoever redeems it the admin, once', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const sam = await createTestUser(db, 'Sam');
    const token = await mintClaimToken(db);

    assert.deepEqual(await checkClaimToken(db, token), { ok: true });
    assert.deepEqual(await redeemClaimToken(db, token, josh.id), { ok: true });
    assert.equal(await isInstanceAdmin(db, josh.id), true);

    assert.deepEqual(await redeemClaimToken(db, token, sam.id), { ok: false, reason: 'claimed' });
    assert.equal(await isInstanceAdmin(db, sam.id), false, 'a used link is not a second way in');
  });

  it('keeps only a hash of the token', async () => {
    const db = await createTestDb();
    const token = await mintClaimToken(db);
    const [row] = await db.select().from(instanceSettings);
    assert.ok(row?.claimTokenHash);
    assert.match(row.claimTokenHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(token.slice('claim1.'.length)));
  });

  it('is replaced by the next one: only the newest link works', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const old = await mintClaimToken(db);
    const current = await mintClaimToken(db);

    assert.deepEqual(await redeemClaimToken(db, old, josh.id), { ok: false, reason: 'unknown' });
    assert.equal(await isInstanceAdmin(db, josh.id), false);
    assert.deepEqual(await redeemClaimToken(db, current, josh.id), { ok: true });
  });

  it('is dead once anybody runs the instance, however they came to', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Owner');
    const late = await createTestUser(db, 'Late');
    const token = await mintClaimToken(db);

    // Granted from a shell, without the link: the link must not still work.
    await setInstanceAdmin(db, owner.id, true);
    assert.deepEqual(await checkClaimToken(db, token), { ok: false, reason: 'claimed' });
    assert.deepEqual(await redeemClaimToken(db, token, late.id), { ok: false, reason: 'claimed' });
    assert.equal(await isInstanceAdmin(db, late.id), false);
  });

  it('lets exactly one of several people opening it at once in', async () => {
    const db = await createTestDb();
    const people = await Promise.all(['A', 'B', 'C', 'D'].map((name) => createTestUser(db, name)));
    const token = await mintClaimToken(db);

    const results = await Promise.all(people.map((person) => redeemClaimToken(db, token, person.id)));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal((await listInstanceAdmins(db)).length, 1);
  });

  it('refuses anything that is not a token of ours, before a lookup', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    await mintClaimToken(db);
    for (const bad of ['', 'claim1.short', 'v2.' + 'a'.repeat(43), 42, null]) {
      assert.equal(parseClaimToken(bad), null);
      assert.deepEqual(await redeemClaimToken(db, bad, josh.id), { ok: false, reason: 'unknown' });
    }
    assert.equal(await isInstanceAdmin(db, josh.id), false);
  });

  it('does not disturb the instance name sharing its row', async () => {
    const db = await createTestDb();
    await saveInstanceSettings(db, { name: 'Acme' });
    const token = await mintClaimToken(db);
    assert.equal((await getInstanceSettings(db)).name, 'Acme');
    await saveInstanceSettings(db, { name: 'Acme HQ' });
    assert.deepEqual(await checkClaimToken(db, token), { ok: true }, 'renaming must not void the link');
  });

  it('is opened at /claim on the deployment origin', () => {
    assert.equal(claimUrl('https://office.example.com', 'claim1.abc'), 'https://office.example.com/claim?t=claim1.abc');
  });
});

describe('settling who runs a shared server, on boot', () => {
  it('prints a fresh link while nobody does', async () => {
    const db = await createTestDb();
    const first = await settleInstanceAdmin(db, null);
    assert.equal(first.kind, 'claim');
    const second = await settleInstanceAdmin(db, null);
    assert.equal(second.kind, 'claim');

    // Each boot's link replaces the last one.
    const josh = await createTestUser(db, 'Josh');
    if (first.kind !== 'claim' || second.kind !== 'claim') throw new Error('unreachable');
    assert.deepEqual(await checkClaimToken(db, first.token), { ok: false, reason: 'unknown' });
    assert.deepEqual(await redeemClaimToken(db, second.token, josh.id), { ok: true });
  });

  it('prints nothing, and clears any link, once somebody does', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    await mintClaimToken(db);
    await setInstanceAdmin(db, josh.id, true);

    assert.deepEqual(await settleInstanceAdmin(db, null), { kind: 'settled' });
    const [row] = await db.select().from(instanceSettings);
    assert.equal(row?.claimTokenHash, null);
  });

  it('makes a named owner the admin, and leaves nothing to claim', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Owner');
    await mintClaimToken(db);

    assert.deepEqual(await settleInstanceAdmin(db, owner.pubkey), {
      kind: 'owner',
      pubkey: owner.pubkey,
      signedIn: true,
    });
    assert.equal(await isInstanceAdmin(db, owner.id), true);
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 'global'));
    assert.equal(row?.claimTokenHash, null);
  });

  it('waits for a named owner who has not signed in yet', async () => {
    const db = await createTestDb();
    const someone = await createTestUser(db, 'Someone else');
    const owner = 'ab'.repeat(32);

    assert.deepEqual(await settleInstanceAdmin(db, owner), { kind: 'owner', pubkey: owner, signedIn: false });
    assert.equal(await isInstanceAdmin(db, someone.id), false);
  });
});
