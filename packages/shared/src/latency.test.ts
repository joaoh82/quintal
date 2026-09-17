import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latencyRequestId } from './latency.js';

test('latency correlation accepts only bounded UUIDs', () => {
  assert.equal(latencyRequestId('ABCDEF01-1234-4321-ABCD-0123456789AB'), 'abcdef01-1234-4321-abcd-0123456789ab');
  for (const value of [undefined, null, {}, 'secret', 'a'.repeat(10000), '../file']) assert.equal(latencyRequestId(value), undefined);
});

test('activity keeps at most twenty validated human correlations', async () => {
  const { parseActivity } = await import('./activity.js');
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const value = { version: 1, turnId: 'turn', requestId: id, requestIds: [id], workerId: '0', sessionId: 'session', sequence: 1, state: 'queued', startedAt: 1, updatedAt: 1, items: [] };
  assert.deepEqual(parseActivity(value)?.requestIds, [id]);
  assert.equal(parseActivity({ ...value, requestIds: Array(21).fill(id) }), null);
  assert.equal(parseActivity({ ...value, requestIds: ['private content'] }), null);
});
