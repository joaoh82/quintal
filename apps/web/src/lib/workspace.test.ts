import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { currentOffice } from './workspace';

/**
 * Which office a request is in.
 *
 * One rule for every page: a guest is in the office their session was
 * granted, a member is in their own. The bug this replaces was every page
 * answering "your own" — so a guest's header named an empty office while
 * the room below it was the host's.
 */
describe('the office a session is in', () => {
  it('is your own, when you are a member', async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');

    const here = await currentOffice(db, {
      user: { id: ana.id, name: ana.name, pubkey: ana.pubkey },
      session: { isGuest: false, guestWorkspaceId: null },
    });

    assert.equal(here?.workspace.id, ana.workspaceId);
    assert.equal(here?.role, 'owner');
  });

  it("is the host's, when you are a guest — never your own", async () => {
    const db = await createTestDb();
    const ana = await createTestUser(db, 'Ana');
    const guest = await createTestUser(db, 'Guest');

    const here = await currentOffice(db, {
      user: { id: guest.id, name: guest.name, pubkey: guest.pubkey },
      session: { isGuest: true, guestWorkspaceId: ana.workspaceId },
    });

    assert.equal(here?.workspace.id, ana.workspaceId, 'the office that invited them');
    assert.equal(here?.role, 'guest');
    assert.notEqual(here?.workspace.id, guest.workspaceId, 'not the one they own');
  });

  it('is nowhere for a guest whose grant is missing or points at nothing', async () => {
    const db = await createTestDb();
    const guest = await createTestUser(db, 'Guest');
    const asGuest = (grant: string | null) =>
      currentOffice(db, {
        user: { id: guest.id, name: guest.name, pubkey: guest.pubkey },
        session: { isGuest: true, guestWorkspaceId: grant },
      });

    // A guest with no grant must not fall through to their own office and
    // find themselves administering it under a Guest badge.
    assert.equal(await asGuest(null), null);
    assert.equal(await asGuest('no-such-office'), null);
  });
});
