import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INVITE_MAX_USES_LIMIT,
  checkInviteLink,
  createInviteLink,
  ensureMembership,
  listInviteLinks,
  parseInviteToken,
  redeemInviteLink,
  revokeInviteLink,
} from './invites.js';
import { listWorkspacesForUser } from './workspaces.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * Guest links, against a real database.
 *
 * A guest link is the one credential in Quintal that gets forwarded on purpose,
 * so the interesting cases are all about what happens after it leaves the hands
 * of the person who made it: after it expires, after it has been spent, after
 * it is revoked, and when two people arrive on the last use at once.
 */

async function setup() {
  const db = await createTestDb();
  const host = await createTestUser(db, 'Host');
  return { db, host };
}

describe('parseInviteToken', () => {
  it('accepts what we issue', async () => {
    const { db, host } = await setup();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    assert.ok(token.startsWith('v2.'));
    assert.equal(parseInviteToken(token), token);
    assert.equal(parseInviteToken(`  ${token}  `), token);
  });

  it('rejects everything else without a database round trip', () => {
    assert.equal(parseInviteToken(null), null);
    assert.equal(parseInviteToken(''), null);
    assert.equal(parseInviteToken('v1.oldformat'), null);
    assert.equal(parseInviteToken('v2.tooshort'), null);
    assert.equal(parseInviteToken(`v2.${'a'.repeat(44)}`), null);
    assert.equal(parseInviteToken(`v2.${'/'.repeat(43)}`), null, 'base64url only');
  });
});

describe('createInviteLink', () => {
  it('stores a hash, never the token', async () => {
    const { db, host } = await setup();
    const { link, token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    assert.notEqual(link.tokenHash, token);
    assert.match(link.tokenHash, /^[0-9a-f]{64}$/);

    const stored = await listInviteLinks(db, host.workspaceId);
    assert.equal(stored.length, 1);
    assert.ok(
      !JSON.stringify(stored).includes(token.slice(3)),
      'the plaintext must not be recoverable from the row',
    );
  });

  it('defaults to one use and 72 hours', async () => {
    const { db, host } = await setup();
    const { link } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    assert.equal(link.maxUses, 1);
    assert.equal(link.role, 'member');
    const hours = (link.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 71 && hours <= 72, `expected ~72h, got ${hours}`);
  });

  it('clamps max uses to the ceiling', async () => {
    const { db, host } = await setup();
    const { link } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 10_000,
    });
    assert.equal(link.maxUses, INVITE_MAX_USES_LIMIT);

    const floored = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 0,
    });
    assert.equal(floored.link.maxUses, 1);
  });
});

describe('redeemInviteLink', () => {
  it('spends one use at a time', async () => {
    const { db, host } = await setup();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 3,
    });

    for (let i = 1; i <= 3; i += 1) {
      const redeemed = await redeemInviteLink(db, token);
      assert.ok(redeemed.ok, `use ${i} should be allowed`);
      assert.equal(redeemed.link.usedCount, i);
    }

    const fourth = await redeemInviteLink(db, token);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.ok === false ? fourth.reason : null, 'exhausted');
  });

  it('refuses an expired link even with uses left', async () => {
    const { db, host } = await setup();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 50,
      ttlMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const redeemed = await redeemInviteLink(db, token);
    assert.equal(redeemed.ok, false);
    assert.equal(redeemed.ok === false ? redeemed.reason : null, 'expired');
  });

  it('refuses a revoked link immediately', async () => {
    const { db, host } = await setup();
    const { link, token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 10,
    });

    await revokeInviteLink(db, link.id, host.workspaceId);

    const redeemed = await redeemInviteLink(db, token);
    assert.equal(redeemed.ok, false);
    assert.equal(redeemed.ok === false ? redeemed.reason : null, 'revoked');
  });

  it('will not let a link be revoked from another workspace', async () => {
    const { db, host } = await setup();
    const stranger = await createTestUser(db, 'Stranger');
    const { link, token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
    });

    await revokeInviteLink(db, link.id, stranger.workspaceId);

    const check = await checkInviteLink(db, token);
    assert.ok(check.ok, "somebody else's revoke must not touch this link");
  });

  it('does not overspend when the last use is claimed twice at once', async () => {
    const { db, host } = await setup();
    const { token } = await createInviteLink(db, {
      workspaceId: host.workspaceId,
      createdByUserId: host.id,
      maxUses: 1,
    });

    // Both callers pass the read-only check; only one may pass the update.
    const [a, b] = await Promise.all([
      redeemInviteLink(db, token),
      redeemInviteLink(db, token),
    ]);

    const accepted = [a, b].filter((result) => result.ok).length;
    assert.equal(accepted, 1, 'exactly one of the two racing guests gets in');
  });

  it('refuses a token that was never issued', async () => {
    const { db } = await setup();
    const redeemed = await redeemInviteLink(db, `v2.${'A'.repeat(43)}`);
    assert.equal(redeemed.ok, false);
    assert.equal(redeemed.ok === false ? redeemed.reason : null, 'unknown');
  });
});

describe('ensureMembership', () => {
  it('adds the guest once, however many times it is called', async () => {
    const { db, host } = await setup();
    const guest = await createTestUser(db, 'Guest');

    for (let i = 0; i < 3; i += 1) {
      await ensureMembership(db, {
        workspaceId: host.workspaceId,
        userId: guest.id,
        role: 'member',
      });
    }

    const joined = await listWorkspacesForUser(db, guest.id);
    const inHosts = joined.filter(
      (row) => row.workspace.id === host.workspaceId,
    );
    assert.equal(inHosts.length, 1);
    assert.equal(inHosts[0]?.role, 'member');
  });
});
