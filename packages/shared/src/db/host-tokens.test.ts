import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignedToHost, hostMayActAs } from './host-tokens.js';

/**
 * A host token is the most powerful credential in the system: it can act as
 * every agent its owner assigned to one machine. These two predicates are the
 * entire reason that is safe, so they are tested exhaustively rather than
 * incidentally.
 */

const HOST = { workspaceId: 'ws-1', ownerUserId: 'josh' };

const MINE = {
  workspaceId: 'ws-1',
  ownerUserId: 'josh',
  revoked: false,
  enabled: true,
  hostLabel: 'laptop',
  runtimeId: 'claude-code',
  repoSpec: 'api',
};

describe('what a machine may act as', () => {
  it('lets a machine act as its own owner’s agent in its own workspace', () => {
    assert.equal(hostMayActAs(HOST, MINE), true);
  });

  it('refuses an agent in another workspace', () => {
    assert.equal(hostMayActAs(HOST, { ...MINE, workspaceId: 'ws-2' }), false);
  });

  it('refuses a teammate’s agent — sharing a workspace is not sharing a fleet', () => {
    assert.equal(hostMayActAs(HOST, { ...MINE, ownerUserId: 'sam' }), false);
  });

  it('refuses a revoked agent, so a stale machine cannot resurrect one', () => {
    assert.equal(hostMayActAs(HOST, { ...MINE, revoked: true }), false);
  });

  it('refuses an agent that does not exist', () => {
    assert.equal(hostMayActAs(HOST, null), false);
  });
});

describe('what a machine should be running', () => {
  it('runs an agent assigned to it', () => {
    assert.equal(assignedToHost(MINE, HOST, 'laptop'), true);
  });

  it('does not run an agent assigned to a different machine', () => {
    assert.equal(assignedToHost(MINE, HOST, 'build-box'), false);
    assert.equal(assignedToHost({ ...MINE, hostLabel: 'build-box' }, HOST, 'laptop'), false);
  });

  it('does not run an agent that has never been assigned anywhere', () => {
    assert.equal(assignedToHost({ ...MINE, hostLabel: null }, HOST, 'laptop'), false);
  });

  it('does not run a disabled agent', () => {
    assert.equal(assignedToHost({ ...MINE, enabled: false }, HOST, 'laptop'), false);
  });

  it('leaves per-agent-key agents alone — no runtime means it was never office-defined', () => {
    assert.equal(assignedToHost({ ...MINE, runtimeId: null }, HOST, 'laptop'), false);
    assert.equal(assignedToHost({ ...MINE, repoSpec: null }, HOST, 'laptop'), false);
  });

  it('never runs an agent it may not act as, however it was assigned', () => {
    // The dangerous case: a teammate's agent that names your machine. The
    // assignment must not be enough on its own.
    assert.equal(assignedToHost({ ...MINE, ownerUserId: 'sam' }, HOST, 'laptop'), false);
    assert.equal(assignedToHost({ ...MINE, workspaceId: 'ws-2' }, HOST, 'laptop'), false);
    assert.equal(assignedToHost({ ...MINE, revoked: true }, HOST, 'laptop'), false);
  });
});
