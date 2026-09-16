import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PublicActivity } from '@quintal/shared';

import {
  activityPresentation,
  collapsedActivityItems,
} from './activityPresentation';

const activity = (overrides: Partial<PublicActivity> = {}): PublicActivity => ({
  version: 1,
  turnId: 'turn',
  requestId: 'request',
  workerId: 'worker',
  sessionId: 'session',
  agentId: 'agent',
  agentName: 'Bob',
  sequence: 1,
  state: 'running',
  startedAt: 1,
  updatedAt: 2,
  receivedAt: 2,
  items: [],
  ...overrides,
});

describe('agent activity presentation', () => {
  it('counts only explicit outcomes and keeps missing evidence unknown', () => {
    const view = activityPresentation(activity({
      state: 'completed',
      items: [
        { id: 'ok', kind: 'tool', text: 'ok', state: 'success', startedAt: 1 },
        { id: 'bad', kind: 'tool', text: 'bad', state: 'failed', startedAt: 1 },
        { id: 'maybe', kind: 'tool', text: 'maybe', state: 'unknown', startedAt: 1 },
      ],
    }));

    assert.equal(view.outcomeSummary, '3 completed · 1 succeeded · 1 failed · 1 unknown');
    assert.deepEqual(view.problems.map((item) => item.id), ['bad']);
  });

  it('identifies the live step and exposes terminal cancellation separately', () => {
    const view = activityPresentation(activity({
      items: [
        { id: 'cancelled', kind: 'tool', text: 'old', state: 'cancelled', startedAt: 1 },
        { id: 'running', kind: 'tool', text: 'now', state: 'running', startedAt: 2 },
      ],
    }));

    assert.equal(view.current?.id, 'running');
    assert.deepEqual(view.problems.map((item) => item.id), ['cancelled']);
    assert.match(view.outcomeSummary, /1 cancelled/);
  });

  it('shows the last public message as the final reply only after termination', () => {
    const items: PublicActivity['items'] = [
      { id: 'narration', kind: 'message', text: 'Checking.', state: 'success', startedAt: 1 },
      { id: 'reply', kind: 'message', text: 'Done.', state: 'success', startedAt: 2 },
    ];
    assert.equal(activityPresentation(activity({ items })).finalMessage, undefined);
    assert.equal(
      activityPresentation(activity({ items, state: 'completed' })).finalMessage?.id,
      'reply',
    );
  });

  it('changes only which retained items are collapsed at each level', () => {
    const turn = activity({
      state: 'completed',
      items: [
        { id: 'narration', kind: 'message', text: 'Checking.', state: 'success', startedAt: 1 },
        { id: 'ok', kind: 'tool', text: 'ok', state: 'success', startedAt: 2 },
        { id: 'bad', kind: 'tool', text: 'bad', state: 'failed', startedAt: 3 },
        { id: 'reply', kind: 'message', text: 'Done.', state: 'success', startedAt: 4 },
      ],
    });
    const ids = (level: 'low' | 'balanced' | 'detailed') =>
      collapsedActivityItems(turn, level).map((item) => item.id);

    assert.deepEqual(ids('low'), ['narration', 'ok']);
    assert.deepEqual(ids('balanced'), ['ok']);
    assert.deepEqual(ids('detailed'), []);
    assert.equal(turn.items.length, 4, 'presentation never removes retained history');
  });
});
