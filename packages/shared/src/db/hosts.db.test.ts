import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { forgetHostReport, listHostsForWorkspace, recordHost } from './hosts.js';
import { createTestDb, createTestUser } from './testing.js';

/**
 * Withdrawing a machine's report.
 *
 * Reports arrive whenever a harness connects and nothing removed one, so a
 * machine that changed name — which macOS does on its own, since `hostname()`
 * follows the network — stayed in the office forever with no way to clear it.
 *
 * The delete is scoped to a workspace *and* an owner, and both halves are
 * tested: an unscoped delete here would let anyone in a shared office erase a
 * teammate's machines, which is the same shape as the workspace bug this
 * codebase has already been bitten by once.
 */
async function setup() {
  const db = await createTestDb();
  const josh = await createTestUser(db, 'Josh');
  const sam = await createTestUser(db, 'Sam', josh.workspaceId);
  return { db, josh, sam };
}

const report = (label: string) => ({ label, reposDir: '/repos', runtimes: [] });

describe('forgetting a machine report', () => {
  it('removes the one asked for', async () => {
    const { db, josh } = await setup();
    await recordHost(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      report: report('Joaos-MBP-2.home'),
    });
    await recordHost(db, {
      workspaceId: josh.workspaceId,
      ownerUserId: josh.id,
      report: report('Joaos-MacBook-Pro-2'),
    });

    assert.equal(
      await forgetHostReport(db, {
        workspaceId: josh.workspaceId,
        ownerUserId: josh.id,
        label: 'Joaos-MBP-2.home',
      }),
      true,
    );

    const left = (await listHostsForWorkspace(db, josh.workspaceId)).map((h) => h.label);
    assert.deepEqual(left, ['Joaos-MacBook-Pro-2']);
  });

  it("will not remove a teammate's machine of the same name", async () => {
    const { db, josh, sam } = await setup();
    await recordHost(db, {
      workspaceId: sam.workspaceId,
      ownerUserId: sam.id,
      report: report('laptop'),
    });

    assert.equal(
      await forgetHostReport(db, {
        workspaceId: josh.workspaceId,
        ownerUserId: josh.id,
        label: 'laptop',
      }),
      false,
      'everybody calls their machine laptop; one must not erase another',
    );

    const left = (await listHostsForWorkspace(db, josh.workspaceId)).map((h) => h.label);
    assert.deepEqual(left, ['laptop'], "Sam's machine is untouched");
  });

  it('says so when there was nothing to forget', async () => {
    const { db, josh } = await setup();
    assert.equal(
      await forgetHostReport(db, {
        workspaceId: josh.workspaceId,
        ownerUserId: josh.id,
        label: 'never-existed',
      }),
      false,
    );
  });
});
