import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatBroadcastPayload } from '@quintal/shared';
import { mergeHistoryPage, type Transcript } from './useConversations';

const line = (sentAt: number): ChatBroadcastPayload => ({
  from: 'human',
  fromName: 'Human',
  fromKind: 'human',
  text: `line ${sentAt}`,
  sentAt,
});
test('active replay older than the page does not skip intervening chat when paging back', () => {
  const replay: ChatBroadcastPayload = {
    ...line(10),
    fromKind: 'agent',
    activity: {
      version: 1,
      turnId: 'old-turn',
      requestId: 'old-turn',
      workerId: '0',
      sessionId: 's',
      agentId: 'a',
      agentName: 'Agent',
      sequence: 1,
      state: 'running',
      startedAt: 10,
      updatedAt: 100,
      receivedAt: 100,
      items: [],
    },
  };
  const current: Transcript = { messages: [replay], hasMore: true, loaded: false, loading: true };
  const first = mergeHistoryPage(current, [line(80), line(90)], true);
  assert.equal(first.messages[0]?.sentAt, 10);
  assert.equal(first.historyBefore, 80, 'page from the fetched boundary, not the old live turn');
  const earlier = mergeHistoryPage(first, [line(60), line(70)], true);
  assert.equal(earlier.historyBefore, 60);
  const refreshed = mergeHistoryPage(earlier, [line(90), line(100)], true);
  assert.equal(refreshed.historyBefore, 60, 'refresh does not discard paging progress');
  assert.deepEqual(
    refreshed.messages.map((m) => m.sentAt),
    [10, 60, 70, 80, 90, 100],
  );
});
