import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { createInviteLink, ensureMembership, redeemInviteLink } from './invites.js';
import { users } from './schema.js';
import { createTestDb, createTestUser } from './testing.js';
import {
  ensurePersonalWorkspace,
  listWorkspacesForUser,
  renameWorkspace,
} from './workspaces.js';
import {
  normaliseWorkspaceName,
  personalWorkspaceName,
  workspaceNameFollows,
} from '../workspace.js';
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

describe('renameWorkspace', () => {
  it('renames the office and moves the slug with it', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');

    const renamed = await renameWorkspace(db, owner.workspaceId, '  Acme  ');

    assert.equal(renamed?.name, 'Acme');
    assert.equal(renamed?.slug, 'acme');
  });

  it('refuses an empty name rather than blanking the header', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');

    assert.equal(await renameWorkspace(db, owner.workspaceId, '   '), null);
    const still = await ensurePersonalWorkspace(db, { userId: owner.id });
    assert.ok(still.name.length > 0);
  });

  it('keeps slugs unique when two offices choose the same name', async () => {
    const db = await createTestDb();
    const a = await createTestUser(db, 'A');
    const b = await createTestUser(db, 'B');

    const first = await renameWorkspace(db, a.workspaceId, 'Acme');
    const second = await renameWorkspace(db, b.workspaceId, 'Acme');

    assert.equal(first?.name, 'Acme');
    assert.equal(second?.name, 'Acme');
    assert.notEqual(first?.slug, second?.slug);
  });

  it('applies the same containment as any other name', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Josh');

    const renamed = await renameWorkspace(db, owner.workspaceId, 'Ac\u202Eme');

    assert.equal(renamed?.name, 'Ac me');
  });

  it('does nothing for an unknown workspace', async () => {
    const db = await createTestDb();
    assert.equal(await renameWorkspace(db, 'nope', 'Acme'), null);
  });
});

describe('workspaceNameFollows', () => {
  it('recognises an office still wearing its owner\'s name', () => {
    // Renaming yourself should carry this one along: it is the old name
    // surviving in a second place, not a choice anybody made.
    assert.ok(workspaceNameFollows("Josh's Office", 'Josh'));
    assert.ok(workspaceNameFollows(personalWorkspaceName('npub1abc…xyz'), 'npub1abc…xyz'));
  });

  it('leaves a deliberately chosen name alone', () => {
    assert.ok(!workspaceNameFollows('Acme', 'Josh'));
    assert.ok(!workspaceNameFollows("Someone else's Office", 'Josh'));
  });
});

describe('normaliseWorkspaceName', () => {
  it('allows a longer name than a person gets, and still clamps', () => {
    assert.equal(normaliseWorkspaceName('  The Lab  '), 'The Lab');
    assert.equal(normaliseWorkspaceName(''), null);
    assert.equal(normaliseWorkspaceName(null), null);
    assert.equal(normaliseWorkspaceName('z'.repeat(200))?.length, 60);
  });
});
