import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getUserActivityDetailLevel,
  setUserActivityDetailLevel,
} from './preferences.js';
import { createTestDb, createTestUser } from './testing.js';

describe('per-user presentation preferences', () => {
  it('defaults agent activity detail to balanced', async () => {
    const db = await createTestDb();
    const user = await createTestUser(db, 'Ana');

    assert.equal(await getUserActivityDetailLevel(db, user.id), 'balanced');
  });

  it('persists independently for two people in the same office', async () => {
    const db = await createTestDb();
    const owner = await createTestUser(db, 'Ana');
    const teammate = await createTestUser(db, 'Joao', { workspaceId: owner.workspaceId });

    await setUserActivityDetailLevel(db, owner.id, 'low');
    await setUserActivityDetailLevel(db, teammate.id, 'detailed');

    assert.equal(await getUserActivityDetailLevel(db, owner.id), 'low');
    assert.equal(await getUserActivityDetailLevel(db, teammate.id), 'detailed');
  });
});
