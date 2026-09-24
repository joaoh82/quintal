import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PublicApprovalRequest, PublicApprovalResolved } from '@quintal/shared';

import {
  EMPTY_APPROVALS,
  approvalKey,
  approvalStatus,
  attentionKeys,
  clearSent,
  noteSent,
  privateApprovals,
  receiveApproval,
  receiveResolution,
  waitingApprovals,
} from './approvals';

const NOW = 1_700_000_000_000;
const ME = 'user-me';

function request(overrides: Partial<PublicApprovalRequest> = {}): PublicApprovalRequest {
  return {
    version: 1,
    requestId: 'req-1',
    turnId: 'turn-1',
    workerId: '0',
    sessionId: 'sess-1',
    channelId: 'ch-1',
    toolName: 'Bash',
    summary: 'git status',
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    askedAt: NOW,
    expiresAt: NOW + 300_000,
    agentId: 'agent-1',
    agentName: 'Bob',
    ownerUserId: ME,
    ownerName: 'Josh',
    receivedAt: NOW,
    ...overrides,
  };
}

function resolved(overrides: Partial<PublicApprovalResolved> = {}): PublicApprovalResolved {
  return {
    version: 1,
    requestId: 'req-1',
    turnId: 'turn-1',
    resolution: 'allowed',
    via: 'card',
    resolvedAt: NOW + 1_000,
    agentId: 'agent-1',
    agentName: 'Bob',
    receivedAt: NOW + 1_000,
    ...overrides,
  };
}

describe('where a card belongs', () => {
  it('goes to its channel, or its zone', () => {
    assert.equal(approvalKey(request()), 'channel:ch-1');
    assert.equal(approvalKey(request({ channelId: undefined, zoneId: 'lobby' })), 'zone:lobby');
    assert.equal(approvalKey(request({ channelId: undefined })), null);
  });
});

describe('what a card says right now', () => {
  it('waits until somebody answers', () => {
    const state = receiveApproval(EMPTY_APPROVALS, request());
    assert.deepEqual(approvalStatus(state, request(), NOW), { kind: 'waiting' });
  });

  it('says sending while our own click is in flight, and stops once it lands', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request());
    state = noteSent(state, 'req-1', 'allow_once');
    assert.deepEqual(approvalStatus(state, request(), NOW), {
      kind: 'sending',
      optionId: 'allow_once',
    });
    state = receiveResolution(state, resolved());
    assert.deepEqual(approvalStatus(state, request(), NOW), {
      kind: 'resolved',
      label: 'Allowed once',
    });
    assert.deepEqual(state.sent, {});
  });

  it('reads as over once the deadline has passed, with no socket needed', () => {
    const state = receiveApproval(EMPTY_APPROVALS, request());
    const status = approvalStatus(state, request(), NOW + 300_001);
    assert.equal(status.kind, 'resolved');
    assert.match(status.kind === 'resolved' ? status.label : '', /No answer in time/);
  });

  it('names every way it can end', () => {
    for (const [resolution, expected] of [
      ['denied', /Denied/],
      ['expired', /No answer in time/],
      ['cancelled', /Cancelled/],
      ['interrupted', /Interrupted/],
      ['auto_allowed', /run scope/],
    ] as const) {
      const state = receiveResolution(receiveApproval(EMPTY_APPROVALS, request()), resolved({ resolution }));
      const status = approvalStatus(state, request(), NOW);
      assert.match(status.kind === 'resolved' ? status.label : '', expected);
    }
  });

  it('un-sticks a click the office refused', () => {
    let state = noteSent(receiveApproval(EMPTY_APPROVALS, request()), 'req-1', 'deny');
    state = clearSent(state, 'req-1');
    assert.deepEqual(approvalStatus(state, request(), NOW), { kind: 'waiting' });
  });
});

describe('what needs my attention', () => {
  const other = request({ requestId: 'req-2', channelId: 'ch-2', ownerUserId: 'somebody-else' });

  it('flags only the conversations holding a card I can answer', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request());
    state = receiveApproval(state, other);
    assert.deepEqual([...attentionKeys(state, ME, NOW)], ['channel:ch-1']);
  });

  it('stops flagging one that has been answered', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request());
    state = receiveResolution(state, resolved({ resolution: 'denied' }));
    assert.equal(attentionKeys(state, ME, NOW).size, 0);
  });

  it('keeps a private card out of the tabs and in my own corner', () => {
    const hidden = request({ requestId: 'req-3', private: true });
    const state = receiveApproval(EMPTY_APPROVALS, hidden);
    assert.equal(attentionKeys(state, ME, NOW).size, 0);
    assert.deepEqual(
      privateApprovals(state, ME, NOW).map((approval) => approval.requestId),
      ['req-3'],
    );
    assert.deepEqual(privateApprovals(state, 'somebody-else', NOW), []);
  });

  it('orders what is waiting oldest first', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request({ requestId: 'later', askedAt: NOW + 10 }));
    state = receiveApproval(state, request({ requestId: 'earlier', askedAt: NOW }));
    assert.deepEqual(
      waitingApprovals(state, NOW).map((approval) => approval.requestId),
      ['earlier', 'later'],
    );
  });

  it('takes a later word about the same request as the current one', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request());
    state = receiveApproval(state, request({ summary: 'git push' }));
    assert.equal(Object.keys(state.requests).length, 1);
    assert.equal(state.requests['req-1']?.summary, 'git push');
  });
});

/**
 * The other half of the reconnect bug. The office resumes a card whose agent
 * dropped and came back, but `approvalStatus` reads `resolved` before
 * anything else — so without this the owner keeps seeing "Interrupted" and no
 * buttons on a question that is genuinely waiting for them. The gateway smoke
 * cannot catch it: it talks to the office directly and never runs this store.
 */
describe('a card the office shows again after its agent reconnected', () => {
  const interrupted = resolved({ resolution: 'interrupted' });

  it('is answerable again once the office re-sends it', () => {
    let state = receiveApproval(EMPTY_APPROVALS, request());
    state = receiveResolution(state, interrupted);
    assert.equal(approvalStatus(state, request(), NOW).kind, 'resolved', 'down while it is gone');

    state = receiveApproval(state, request());
    assert.deepEqual(approvalStatus(state, request(), NOW), { kind: 'waiting' });
    assert.equal(state.resolved['req-1'], undefined, 'the interruption is let go of');
  });

  it('counts towards my attention again', () => {
    let state = receiveResolution(receiveApproval(EMPTY_APPROVALS, request()), interrupted);
    assert.equal(attentionKeys(state, ME, NOW).size, 0);
    state = receiveApproval(state, request());
    assert.deepEqual([...attentionKeys(state, ME, NOW)], ['channel:ch-1']);
  });

  it('will not revive one the harness actually answered', () => {
    for (const resolution of ['allowed', 'denied', 'expired', 'cancelled', 'auto_allowed'] as const) {
      let state = receiveApproval(EMPTY_APPROVALS, request());
      state = receiveResolution(state, resolved({ resolution }));
      state = receiveApproval(state, request());
      assert.equal(
        approvalStatus(state, request(), NOW).kind,
        'resolved',
        `${resolution} must stay resolved`,
      );
      assert.ok(state.resolved['req-1'], `${resolution} is remembered`);
    }
  });

  it('does not resurrect one whose deadline passed while it was away', () => {
    const past = request({ expiresAt: NOW - 1 });
    let state = receiveResolution(receiveApproval(EMPTY_APPROVALS, past), interrupted);
    state = receiveApproval(state, past);
    // The resolution is let go of, but the clock still says it is over.
    assert.equal(approvalStatus(state, past, NOW).kind, 'resolved');
  });
});
