import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  ChatBroadcastPayload,
  PublicActivity,
  PublicApprovalRequest,
} from '@quintal/shared';

import {
  EMPTY_ALERT_LOG,
  QUIET_MS,
  admit,
  approvalAlert,
  doneAlert,
  lineAlert,
  nextWaiting,
  waitingOnMe,
  type Looking,
} from './alerts';
import { EMPTY_APPROVALS, receiveApproval } from './approvals';
import { NEARBY, channelKey, zoneKey } from './conversationKey';

const NOW = 1_700_000_000_000;
const ME = 'user-me';
const CHANNEL = channelKey('ch-1');

const AWAY: Looking = { focused: false, visible: [CHANNEL] };
const READING: Looking = { focused: true, visible: [CHANNEL] };
const ELSEWHERE: Looking = { focused: true, visible: [NEARBY] };

function request(overrides: Partial<PublicApprovalRequest> = {}): PublicApprovalRequest {
  return {
    version: 1,
    requestId: 'req-1',
    turnId: 'turn-1',
    workerId: '0',
    sessionId: 'sess-1',
    channelId: 'ch-1',
    toolName: 'Bash',
    summary: 'git push',
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    askedAt: NOW,
    expiresAt: NOW + 300_000,
    agentId: 'agent-1',
    agentName: 'Marvin',
    ownerUserId: ME,
    ownerName: 'Josh',
    receivedAt: NOW,
    ...overrides,
  };
}

function line(overrides: Partial<ChatBroadcastPayload> = {}): ChatBroadcastPayload {
  return {
    from: 'sess-agent',
    fromName: 'Marvin',
    fromKind: 'agent',
    text: '@Josh review posted',
    sentAt: NOW,
    ...overrides,
  };
}

function turn(overrides: Partial<PublicActivity> = {}): PublicActivity {
  return {
    version: 1,
    turnId: 'turn-1',
    workerId: '0',
    sessionId: 'sess-1',
    requestId: 'r-1',
    sequence: 3,
    channelId: 'ch-1',
    state: 'completed',
    startedAt: NOW,
    updatedAt: NOW,
    items: [],
    agentId: 'agent-1',
    agentName: 'Marvin',
    receivedAt: NOW,
    ...overrides,
  };
}

const CONTEXT = { selfSessionId: 'sess-me', myName: 'Josh', isDm: false };

describe('a permission request', () => {
  it('interrupts the owner who is not looking, and says what for', () => {
    const alert = approvalAlert(request(), ME, AWAY);
    assert.ok(alert);
    assert.equal(alert.title, 'Marvin needs your permission');
    assert.equal(alert.body, 'Bash: git push');
    assert.equal(alert.key, CHANNEL);
  });

  it('never interrupts anybody about an agent that is not theirs', () => {
    assert.equal(approvalAlert(request({ ownerUserId: 'user-other' }), ME, AWAY), null);
  });

  it('interrupts nobody before we know who we are', () => {
    assert.equal(approvalAlert(request({ ownerUserId: '' }), '', AWAY), null);
  });

  it('is silent when the card is on screen, and not when it is a tab away', () => {
    assert.equal(approvalAlert(request(), ME, READING), null);
    assert.ok(approvalAlert(request(), ME, ELSEWHERE));
  });

  it('counts a spatial card as on screen in the nearby box', () => {
    const spatial = request({ channelId: undefined, zoneId: 'focus' });
    assert.equal(approvalAlert(spatial, ME, { focused: true, visible: [NEARBY] }), null);
    assert.ok(approvalAlert(spatial, ME, { focused: true, visible: [zoneKey('other')] }));
  });

  it('treats a private card as on screen whenever the window is', () => {
    const own = request({ private: true });
    assert.equal(approvalAlert(own, ME, ELSEWHERE), null);
    assert.equal(approvalAlert(own, ME, AWAY)?.key, null);
  });
});

describe('a line from an agent', () => {
  it('interrupts when it names me and I am away', () => {
    assert.equal(lineAlert(CHANNEL, line(), CONTEXT, AWAY)?.body, '@Josh review posted');
  });

  it('interrupts in a DM without naming me', () => {
    const dm = { ...CONTEXT, isDm: true };
    assert.ok(lineAlert(CHANNEL, line({ text: 'done' }), dm, AWAY));
  });

  it('does not interrupt for talk that is not for me', () => {
    assert.equal(lineAlert(CHANNEL, line({ text: 'done' }), CONTEXT, AWAY), null);
  });

  it('does not interrupt for a person — that is not this feature', () => {
    assert.equal(lineAlert(CHANNEL, line({ fromKind: 'human' }), CONTEXT, AWAY), null);
  });

  it('never interrupts me with my own words', () => {
    assert.equal(lineAlert(CHANNEL, line({ from: 'sess-me' }), CONTEXT, AWAY), null);
  });

  it('is silent in the conversation I am reading, loud once the window is not focused', () => {
    assert.equal(lineAlert(CHANNEL, line(), CONTEXT, READING), null);
    assert.ok(lineAlert(CHANNEL, line(), CONTEXT, AWAY));
  });
});

describe('a finished turn', () => {
  it('interrupts for my agent finishing or failing', () => {
    assert.equal(doneAlert(turn(), true, CHANNEL, AWAY)?.title, 'Marvin is done');
    assert.equal(
      doneAlert(turn({ state: 'failed' }), true, CHANNEL, AWAY)?.title,
      'Marvin could not finish',
    );
  });

  it('says nothing about somebody else\'s agent', () => {
    assert.equal(doneAlert(turn(), false, CHANNEL, AWAY), null);
  });

  it('says nothing while the turn is still going, or when it was stopped', () => {
    for (const state of ['running', 'writing', 'cancelled', 'interrupted', 'disconnected'] as const) {
      assert.equal(doneAlert(turn({ state }), true, CHANNEL, AWAY), null, state);
    }
  });

  it('is silent when its conversation is on screen', () => {
    assert.equal(doneAlert(turn(), true, CHANNEL, READING), null);
  });
});

describe('admit', () => {
  const approval = approvalAlert(request(), ME, AWAY)!;
  const reply = lineAlert(CHANNEL, line(), CONTEXT, AWAY)!;
  const done = doneAlert(turn(), true, CHANNEL, AWAY)!;

  it('raises a thing once: a re-sent card is the same question', () => {
    const first = admit(EMPTY_ALERT_LOG, approval, 'Marvin', NOW);
    assert.equal(first.raise, true);
    assert.equal(admit(first.log, approval, 'Marvin', NOW + 60_000).raise, false);
  });

  it('folds a reply and the end of its turn into one interruption', () => {
    const first = admit(EMPTY_ALERT_LOG, reply, 'Marvin', NOW);
    assert.equal(admit(first.log, done, 'Marvin', NOW + 500).raise, false);
    assert.equal(admit(first.log, done, 'Marvin', NOW + QUIET_MS).raise, true);
    // A different agent is a different interruption.
    assert.equal(admit(first.log, done, 'Arthur', NOW + 500).raise, true);
  });

  it('never swallows a permission request behind a line that came just before', () => {
    const first = admit(EMPTY_ALERT_LOG, reply, 'Marvin', NOW);
    assert.equal(admit(first.log, approval, 'Marvin', NOW + 500).raise, true);
  });
});

describe('what is waiting on me', () => {
  const mine = receiveApproval(EMPTY_APPROVALS, request());
  const both = receiveApproval(
    mine,
    request({ requestId: 'req-2', channelId: 'ch-2', askedAt: NOW + 1, ownerUserId: 'user-other' }),
  );

  it('counts my agents\' open cards and nobody else\'s', () => {
    assert.equal(waitingOnMe(both, ME, NOW), 1);
    assert.equal(waitingOnMe(both, '', NOW), 0);
    assert.equal(waitingOnMe(both, ME, NOW + 400_000), 0, 'an expired card is not waiting');
  });

  it('goes to a card before a mention, and walks on from where I am', () => {
    const other = channelKey('ch-9');
    const unread = { [other]: { count: 1, mentioned: true, newestAt: NOW } };
    assert.equal(nextWaiting(mine, unread, ME, NEARBY, NOW), CHANNEL);
    assert.equal(nextWaiting(mine, unread, ME, CHANNEL, NOW), other);
    assert.equal(nextWaiting(mine, unread, ME, other, NOW), CHANNEL);
  });

  it('ignores unread chatter that was not for me', () => {
    const unread = { [channelKey('ch-9')]: { count: 4, mentioned: false, newestAt: NOW } };
    assert.equal(nextWaiting(EMPTY_APPROVALS, unread, ME, NEARBY, NOW), null);
  });

  it('has nowhere to go when I am already on the only one', () => {
    assert.equal(nextWaiting(mine, {}, ME, CHANNEL, NOW), null);
  });
});
