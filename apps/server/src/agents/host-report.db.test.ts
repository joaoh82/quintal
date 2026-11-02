import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recordHost, listHostsForWorkspace } from '@quintal/shared/db';
import { createTestDb, createTestUser } from '@quintal/shared/db/testing';

import { hostReportOf } from './gateway.js';

/**
 * From the wire to the row. The room rebuilds a host report field by field
 * before it is stored, which is where a field added to the protocol goes
 * missing without anybody noticing: the harness sends it, the tests of
 * each side pass, and the office never sees it.
 */
describe('a host report, from the wire to the row', () => {
  it('keeps the checkouts a harness names, and leaves them alone when it did not look', async () => {
    const db = await createTestDb();
    const josh = await createTestUser(db, 'Josh');
    const who = { workspaceId: josh.workspaceId, ownerUserId: josh.id };
    const wire = { label: 'laptop', reposDir: '/repos', workspacePath: '/nest' };

    await recordHost(db, { ...who, report: hostReportOf({ ...wire, runtimes: [], checkouts: ['api', 'group/web'] }) });
    assert.deepEqual((await listHostsForWorkspace(db, josh.workspaceId))[0]?.checkouts, ['api', 'group/web']);

    await recordHost(db, { ...who, report: hostReportOf(wire) });
    assert.deepEqual((await listHostsForWorkspace(db, josh.workspaceId))[0]?.checkouts, ['api', 'group/web'], 'not looked is not "none"');

    await recordHost(db, { ...who, report: hostReportOf({ ...wire, checkouts: [] }) });
    assert.deepEqual((await listHostsForWorkspace(db, josh.workspaceId))[0]?.checkouts, [], 'looked and found nothing');
  });

  it('passes nothing it was not sent', () => {
    assert.deepEqual(hostReportOf({ label: 'l', reposDir: '/r', workspacePath: '/w' }), { label: 'l', reposDir: '/r' });
    assert.deepEqual(hostReportOf(undefined), { label: undefined, reposDir: undefined });
  });
});
