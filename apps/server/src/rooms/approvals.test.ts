import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { APPROVAL_EXPIRY_GRACE_MS, APPROVAL_KEEP_RESOLVED_MS } from '@quintal/shared';

import {
  canSeeApproval,
  expiredApprovals,
  forgettableApprovals,
  judgeDecision,
  needsPrivateCopy,
  resumableApproval,
  type TrackedApproval,
} from './approvals.js';

const NOW = 1_700_000_000_000;
const OWNER = 'user-owner';

function tracked(overrides: Partial<TrackedApproval> = {}): TrackedApproval {
  return {
    value: {
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
      ownerUserId: OWNER,
      ownerName: 'Josh',
      receivedAt: NOW,
    },
    owner: 'socket-1',
    conversationId: 'conv-1',
    x: 100,
    y: 100,
    ...overrides,
  };
}

describe('who may answer an approval', () => {
  it('lets the owner allow it once', () => {
    const verdict = judgeDecision(tracked(), { requestId: 'req-1', optionId: 'allow_once' }, OWNER, NOW);
    assert.deepEqual(verdict, { ok: true, optionId: 'allow_once' });
  });

  it('refuses everybody else, and tells them nothing about it', () => {
    const verdict = judgeDecision(tracked(), { requestId: 'req-1', optionId: 'allow_once' }, 'someone-else', NOW);
    assert.equal(verdict.ok, false);
    // Same answer as a request that does not exist: a stranger who guessed an
    // id learns neither whose agent it is nor that it is real.
    assert.equal(verdict.ok === false && verdict.code, 'not_found');
    assert.equal(verdict.ok === false ? verdict.message : '', 'That request is no longer waiting.');
    assert.equal(/Josh|Bob/.test(verdict.ok === false ? verdict.message : ''), false);
  });

  it('refuses a request this office is not holding', () => {
    const verdict = judgeDecision(undefined, { requestId: 'ghost', optionId: 'deny' }, OWNER, NOW);
    assert.equal(verdict.ok === false && verdict.code, 'not_found');
  });

  it('refuses a second click on one already answered', () => {
    const entry = tracked({ decidedBy: 'Josh' });
    const verdict = judgeDecision(entry, { requestId: 'req-1', optionId: 'deny' }, OWNER, NOW);
    assert.equal(verdict.ok === false && verdict.code, 'not_found');
  });

  it('refuses one the harness has already resolved', () => {
    const entry = tracked({ resolvedAt: NOW });
    assert.equal(judgeDecision(entry, { requestId: 'req-1', optionId: 'deny' }, OWNER, NOW).ok, false);
  });

  it('refuses an answer that arrives after the deadline', () => {
    const entry = tracked();
    const verdict = judgeDecision(entry, { requestId: 'req-1', optionId: 'allow_once' }, OWNER, entry.value.expiresAt);
    assert.equal(verdict.ok === false && verdict.code, 'not_found');
  });

  it('refuses an option the card never offered, however it was crafted', () => {
    const entry = tracked({ value: { ...tracked().value, options: [{ id: 'deny', label: 'Deny' }] } });
    const verdict = judgeDecision(entry, { requestId: 'req-1', optionId: 'allow_once' }, OWNER, NOW);
    assert.equal(verdict.ok === false && verdict.code, 'invalid_payload');
  });

  it('keeps two same-named tools in different conversations apart', () => {
    const a = tracked();
    const b = tracked({
      value: { ...tracked().value, requestId: 'req-2', channelId: 'ch-2', sessionId: 'sess-2' },
    });
    // The lookup is by id; answering one can never reach the other.
    assert.equal(judgeDecision(a, { requestId: 'req-1', optionId: 'deny' }, OWNER, NOW).ok, true);
    assert.equal(b.value.requestId, 'req-2');
    assert.notEqual(a.value.requestId, b.value.requestId);
  });
});

describe('who sees an approval card', () => {
  const radius = 200;

  it('shows a channel card to members and nobody else', () => {
    const entry = tracked();
    assert.equal(
      canSeeApproval(entry, { x: 0, y: 0, inChannel: true, followedZone: null }, radius),
      true,
    );
    assert.equal(
      canSeeApproval(entry, { x: 100, y: 100, inChannel: false, followedZone: null }, radius),
      false,
      'standing next to the agent does not open its channel',
    );
  });

  it('shows a spatial card within earshot, or to a zone reader', () => {
    const entry = tracked({ value: { ...tracked().value, channelId: undefined, zoneId: 'lobby' } });
    assert.equal(
      canSeeApproval(entry, { x: 150, y: 100, inChannel: false, followedZone: null }, radius),
      true,
    );
    assert.equal(
      canSeeApproval(entry, { x: 900, y: 900, inChannel: false, followedZone: null }, radius),
      false,
    );
    assert.equal(
      canSeeApproval(entry, { x: 900, y: 900, inChannel: false, followedZone: 'lobby' }, radius),
      true,
    );
  });

  it('gives the owner a private copy exactly when the conversation would not reach them', () => {
    assert.equal(needsPrivateCopy(false), true);
    assert.equal(needsPrivateCopy(true), false);
  });
});

describe('cards the office takes down itself', () => {
  it('expires one the harness never spoke for, after the grace', () => {
    const entry = tracked();
    const at = entry.value.expiresAt;
    assert.deepEqual(expiredApprovals([['req-1', entry]], at), []);
    assert.deepEqual(expiredApprovals([['req-1', entry]], at + APPROVAL_EXPIRY_GRACE_MS), ['req-1']);
  });

  it('leaves a resolved one alone, then forgets it once nobody is looking', () => {
    const entry = tracked({ resolvedAt: NOW });
    assert.deepEqual(expiredApprovals([['req-1', entry]], NOW + 1_000_000), []);
    assert.deepEqual(forgettableApprovals([['req-1', entry]], NOW + 1_000), []);
    assert.deepEqual(
      forgettableApprovals([['req-1', entry]], NOW + APPROVAL_KEEP_RESOLVED_MS + 1),
      ['req-1'],
    );
  });
});

/**
 * A dropped agent socket closes its cards, and Colyseus then gives that socket
 * a grace period to come back. `interrupted` therefore has to be a state a
 * card can return *from* — the first cut of this made it terminal, so any blip
 * left the owner looking at a dead card while the runtime held its tool to the
 * deadline.
 */
describe('a card whose agent dropped and came back', () => {
  it('comes back when the office was the one that closed it', () => {
    const entry = tracked({ resolvedAt: NOW, resolution: 'interrupted' });
    assert.equal(resumableApproval(entry, NOW), true);
  });

  it('stays closed once the harness itself settled it', () => {
    for (const resolution of ['allowed', 'denied', 'cancelled', 'auto_allowed'] as const) {
      const entry = tracked({ resolvedAt: NOW, resolution });
      assert.equal(resumableApproval(entry, NOW), false, resolution);
    }
  });

  it('stays closed if its deadline passed while the socket was down', () => {
    const entry = tracked({ resolvedAt: NOW, resolution: 'interrupted' });
    assert.equal(resumableApproval(entry, entry.value.expiresAt), false);
  });

  it('leaves a card that was never closed alone', () => {
    assert.equal(resumableApproval(tracked(), NOW), true);
  });

  it('will not be revived by an expiry', () => {
    const entry = tracked({ resolvedAt: NOW, resolution: 'expired' });
    assert.equal(resumableApproval(entry, NOW), false);
  });
});
