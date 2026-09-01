import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { memberships } from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { agentBelongsToOffice, mayEnterOffice } from './office.js';

/**
 * Office isolation, against a real database.
 *
 * This is the guarantee the product rests on: an office is a workspace, and
 * another office cannot see that it exists. Not a filter applied to a shared
 * room — a different room, which you are refused entry to.
 *
 * Every test here is a way the old behaviour was wrong. Rooms were keyed by
 * map alone, so one signed-in person saw every agent on the deployment,
 * could address them by name, and they answered.
 */

describe('who may enter an office', () => {
  it('lets a member into their own office', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    assert.equal(
      await mayEnterOffice(
        { userId: josh.id, isGuest: false, guestWorkspaceId: null },
        josh.workspaceId,
        db,
      ),
      true,
    );
  });

  it("refuses somebody else's office", async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const stranger = await createTestUser(db, 'Sam');

    // The whole bug, in one assertion: a perfectly valid session, and an
    // office it has nothing to do with.
    assert.equal(
      await mayEnterOffice(
        { userId: stranger.id, isGuest: false, guestWorkspaceId: null },
        josh.workspaceId,
        db,
      ),
      false,
    );
  });

  it('lets a teammate into the office they share', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const sam = await createTestUser(db, 'Sam');
    // A real membership row, because that is what admission reads. Passing a
    // workspace id to `createTestUser` only tags the user for the host-token
    // tests; it does not make them a member, and a test that relied on it
    // would be asserting against a fixture rather than the product.
    await db.insert(memberships).values({
      id: randomUUID(),
      workspaceId: josh.workspaceId,
      userId: sam.id,
      role: 'member',
    });

    assert.equal(
      await mayEnterOffice(
        { userId: sam.id, isGuest: false, guestWorkspaceId: null },
        josh.workspaceId,
        db,
      ),
      true,
    );
  });

  it('lets a guest into the one office their link was for', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const guest = await createTestUser(db, 'Visitor');

    assert.equal(
      await mayEnterOffice(
        { userId: guest.id, isGuest: true, guestWorkspaceId: josh.workspaceId },
        josh.workspaceId,
        db,
      ),
      true,
    );
  });

  it('refuses a guest any other office', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const other = await createTestUser(db, 'Other');
    const guest = await createTestUser(db, 'Visitor');

    assert.equal(
      await mayEnterOffice(
        { userId: guest.id, isGuest: true, guestWorkspaceId: josh.workspaceId },
        other.workspaceId,
        db,
      ),
      false,
    );
  });

  /**
   * A guest's badge is not a membership, and must not become one. Somebody who
   * happens to also be a member of an office still enters a *different* office
   * as a guest only if their link said so.
   */
  it('does not let a guest fall back to their memberships', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const other = await createTestUser(db, 'Other');

    assert.equal(
      await mayEnterOffice(
        { userId: josh.id, isGuest: true, guestWorkspaceId: other.workspaceId },
        josh.workspaceId,
        db,
      ),
      false,
      'a guest session is bounded by its link, even for a member',
    );
  });

  it('refuses an office nobody named', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');

    assert.equal(
      await mayEnterOffice({ userId: josh.id, isGuest: false, guestWorkspaceId: null }, '', db),
      false,
    );
    // Two empty strings must not compare equal into an admission.
    assert.equal(
      await mayEnterOffice({ userId: josh.id, isGuest: true, guestWorkspaceId: '' }, '', db),
      false,
    );
  });
});

describe('which office an agent belongs in', () => {
  it('admits an agent to the office that defined it', () => {
    assert.equal(agentBelongsToOffice({ workspaceId: 'ws_a' }, 'ws_a'), true);
  });

  it('refuses an agent any other office', () => {
    // Both credentials land here: an agent key is the agent, a host token is a
    // machine acting for one. Neither carries a right to a different office.
    assert.equal(agentBelongsToOffice({ workspaceId: 'ws_a' }, 'ws_b'), false);
  });

  it('refuses an office nobody named', () => {
    assert.equal(agentBelongsToOffice({ workspaceId: '' }, ''), false);
  });
});
