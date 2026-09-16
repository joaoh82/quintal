import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityText,
  mergeActivity,
  parseActivity,
  type AgentActivity,
  type PublicActivity,
} from './activity.js';

const snapshot = (): AgentActivity => ({
  version: 1,
  turnId: 'turn-1',
  workerId: 'worker-1',
  sessionId: 'session-1',
  requestId: 'request-1',
  sequence: 1,
  channelId: 'private',
  state: 'running',
  startedAt: 1,
  updatedAt: 2,
  items: [],
});

test('the public boundary removes unknown fields and rejects malformed or oversized snapshots', () => {
  assert.deepEqual(
    parseActivity({ ...snapshot(), thought: 'private', agentId: 'forged' }),
    snapshot(),
  );
  assert.equal(parseActivity({ ...snapshot(), sequence: -1 }), null);
  assert.equal(parseActivity({ ...snapshot(), zoneId: 'elsewhere' }), null);
  assert.equal(parseActivity({ ...snapshot(), items: Array(65).fill({}) }), null);
  assert.equal(parseActivity({ ...snapshot(), raw: 'x'.repeat(65_000) }), null);
});
test('redacts credentials and removes terminal/control markup without interpreting HTML', () => {
  const clean = activityText(
    '\x1b[31mrun --token secret api_key=hidden Bearer abc.def nsec1abcdef\x00 <script>',
  );
  assert.equal(
    clean,
    'run --token [redacted] api_key=[redacted] Bearer [redacted] [redacted] <script>',
  );
});
test('duplicate/out-of-order snapshots cannot rewind; server disconnect revisions win ties', () => {
  const current: PublicActivity = {
    ...snapshot(),
    agentId: 'a',
    agentName: 'A',
    receivedAt: 3,
    sequence: 4,
  };
  assert.equal(mergeActivity(current, { ...current, sequence: 2 }), current);
  assert.equal(mergeActivity(current, { ...current }), current);
  assert.equal(
    mergeActivity(current, { ...current, receivedAt: 4, state: 'disconnected' }).state,
    'disconnected',
  );
});
