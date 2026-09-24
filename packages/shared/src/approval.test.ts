import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPROVAL_MAX_SUMMARY,
  approvalPending,
  describeResolution,
  parseApprovalDecide,
  parseApprovalRequest,
  parseApprovalResolved,
} from './approval.js';

const base = {
  version: 1 as const,
  requestId: 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff',
  turnId: 'turn-1',
  workerId: '0',
  sessionId: 'sess-1',
  toolName: 'Bash',
  summary: 'git status',
  options: [
    { id: 'allow_once' as const, label: 'Allow once' },
    { id: 'deny' as const, label: 'Deny' },
  ],
  askedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_300_000,
  channelId: 'ch-1',
};

describe('an approval request at the trust boundary', () => {
  it('keeps only the fields the contract names', () => {
    const parsed = parseApprovalRequest({ ...base, evil: 'x', ownerUserId: 'somebody-else' });
    assert.ok(parsed);
    assert.equal(Object.hasOwn(parsed, 'evil'), false);
    assert.equal(Object.hasOwn(parsed, 'ownerUserId'), false);
    assert.equal(parsed.toolName, 'Bash');
    assert.equal(parsed.channelId, 'ch-1');
  });

  it('refuses a request with no identity, no deadline or both scopes at once', () => {
    assert.equal(parseApprovalRequest({ ...base, requestId: '' }), null);
    assert.equal(parseApprovalRequest({ ...base, expiresAt: base.askedAt }), null);
    assert.equal(parseApprovalRequest({ ...base, zoneId: 'lobby' }), null);
    assert.equal(parseApprovalRequest({ ...base, version: 2 }), null);
    assert.equal(parseApprovalRequest({ ...base, toolName: '   ' }), null);
  });

  it('refuses options it cannot honour, and duplicates of one it can', () => {
    assert.equal(parseApprovalRequest({ ...base, options: [] }), null);
    assert.equal(
      parseApprovalRequest({ ...base, options: [{ id: 'allow_always', label: 'Always' }] }),
      null,
    );
    assert.equal(
      parseApprovalRequest({
        ...base,
        options: [
          { id: 'deny', label: 'Deny' },
          { id: 'deny', label: 'Deny' },
        ],
      }),
      null,
    );
  });

  it('gives a button a name when the harness sent none', () => {
    const parsed = parseApprovalRequest({ ...base, options: [{ id: 'allow_once', label: '' }] });
    assert.deepEqual(parsed?.options, [{ id: 'allow_once', label: 'Allow once' }]);
  });

  it('redacts and bounds the summary, which is a command line', () => {
    const parsed = parseApprovalRequest({
      ...base,
      summary: `curl -H 'Authorization: Bearer sk-abcdef123456' https://user:pw@example.com ${'x'.repeat(1000)}`,
    });
    assert.ok(parsed);
    assert.equal(parsed.summary.includes('sk-abcdef123456'), false);
    assert.equal(parsed.summary.includes(':pw@'), false);
    assert.ok(parsed.summary.length <= APPROVAL_MAX_SUMMARY);
  });

  it('strips control sequences from a tool name', () => {
    const escape = String.fromCharCode(27);
    const parsed = parseApprovalRequest({ ...base, toolName: `${escape}[31mBash` });
    assert.equal(parsed?.toolName, 'Bash');
  });
});

describe('a resolution and a decision', () => {
  it('accepts the six ways a question can stop waiting', () => {
    const outcomes = [
      'allowed',
      'denied',
      'expired',
      'cancelled',
      'interrupted',
      'auto_allowed',
    ] as const;
    for (const resolution of outcomes) {
      const parsed = parseApprovalResolved({
        version: 1,
        requestId: base.requestId,
        turnId: 'turn-1',
        resolution,
        via: 'system',
        resolvedAt: 1,
      });
      assert.equal(parsed?.resolution, resolution);
      assert.ok(describeResolution({ resolution }).length > 0);
    }
  });

  it('refuses a resolution that invents an outcome or an option', () => {
    const good = { version: 1, requestId: base.requestId, turnId: 'turn-1', via: 'card', resolvedAt: 1 };
    assert.equal(parseApprovalResolved({ ...good, resolution: 'maybe' }), null);
    assert.equal(parseApprovalResolved({ ...good, resolution: 'allowed', optionId: 'allow_always' }), null);
    assert.equal(parseApprovalResolved({ ...good, resolution: 'allowed', via: 'telepathy' }), null);
  });

  it('refuses a decision that names an option nobody offers', () => {
    assert.deepEqual(parseApprovalDecide({ requestId: base.requestId, optionId: 'deny' }), {
      requestId: base.requestId,
      optionId: 'deny',
    });
    assert.equal(parseApprovalDecide({ requestId: base.requestId, optionId: 'allow_always' }), null);
    assert.equal(parseApprovalDecide({ requestId: '', optionId: 'deny' }), null);
  });
});

describe('the deadline', () => {
  it('stops being answerable once it has passed', () => {
    assert.equal(approvalPending({ expiresAt: 100 }, 99), true);
    assert.equal(approvalPending({ expiresAt: 100 }, 100), false);
  });
});
