import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { createInviteLink, ensureMembership, redeemInviteLink } from './invites.js';
import { users } from './schema.js';
import { createTestDb, createTestUser } from './testing.js';
import { ensurePersonalWorkspace, listWorkspacesForUser } from './workspaces.js';
import { generateSecretKey, getPublicKeyHex } from '../identity.js';

/**
 * Which workspace is "yours".
 *
 * Every caller of `ensurePersonalWorkspace` treats the result as the office the
 * signed-in person administers — `/settings/agents` lists its agents against it,
 * `/settings/guests` mints links for it. So returning somebody else's workspace
 * is not a display bug, it is a privilege escalation, and these tests exist to
 * keep it from becoming one again.
 */

async function newUserRow(db: Awaited<ReturnType<typeof createTestDb>>) {
  const id = randomUUID();
  const pubkey = getPublicKeyHex(generateSecretKey());
  await db.insert(users).values({ id, name: 'Visitor', pubkey });
  return { id, pubkey };
}

describe('ensurePersonalWorkspace', () => {
  it('creates an office you own on first sight, and returns it thereafter', async () => {
    const db = await createTestDb();
    const { id, pubkey } = await newUserRow(db);

    const first = await ensurePersonalWorkspace(db, { userId: id, name: 'Ada', pubkey });
    const second = await ensurePersonalWorkspace(db, { userId: id, name: 'Ada', pubkey });

    assert.equal(first.id, second.id, 'idempotent');
    const memberships = await listWorkspacesForUser(db, id);
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.role, 'owner');
  });

  it('returns the workspace you own, not one you were merely invited into', async () => {
    const db = await createTestDb();
    const host = await createTestUser(db, 'Host');
    const guest = await newUserRow(db);

    const own = await ensurePersonalWorkspace(db, { userId: guest.id, pubkey: guest.pubkey });
    await ensureMembership(db, {
      workspaceId: host.workspaceId,
      userId: guest.id,
      role: 'member',
    });

    const resolved = await ensurePersonalWorkspace(db, {
      userId: guest.id,
      pubkey: guest.pubkey,
    });
    assert.equal(resolved.id, own.id);
    assert.notEqual(resolved.id, host.workspaceId);
  });

  it("does not adopt somebody else's office when the invite lands first", async () => {
    // The order that used to decide it. `ensurePersonalWorkspace` returned on
    // *any* membership, so a guest who joined before having an office of their
    // own inherited the host's — settings page and all.
    const db = await createTestDb();
    const host = await createTestUser(db, 'Host');
    const guest = await newUserRow(db);

    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });
    const redeemed = await redeemInviteLink(db, token);
    assert.ok(redeemed.ok);
    await ensureMembership(db, {
      workspaceId: redeemed.link.workspaceId,
      userId: guest.id,
      role: redeemed.link.role,
    });

    const resolved = await ensurePersonalWorkspace(db, {
      userId: guest.id,
      pubkey: guest.pubkey,
    });

    assert.notEqual(
      resolved.id,
      host.workspaceId,
      'a guest must never resolve to the office that invited them',
    );
    const roles = await listWorkspacesForUser(db, guest.id);
    assert.equal(
      roles.find((r) => r.workspace.id === resolved.id)?.role,
      'owner',
      'whatever comes back, the caller owns it',
    );
  });

  it('is stable for somebody who belongs to several workspaces', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Owner');
    const a = await createTestUser(db, 'A');
    const b = await createTestUser(db, 'B');

    await ensureMembership(db, { workspaceId: a.workspaceId, userId: owner.id, role: 'member' });
    await ensureMembership(db, { workspaceId: b.workspaceId, userId: owner.id, role: 'admin' });

    for (let i = 0; i < 3; i += 1) {
      const resolved = await ensurePersonalWorkspace(db, { userId: owner.id });
      assert.equal(resolved.id, owner.workspaceId);
    }
  });
});
