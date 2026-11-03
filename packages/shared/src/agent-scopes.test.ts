import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_AGENT_SCOPES, grantableScopes, scopesBeyondGrant, scopesOutOfReach } from './agent.js';

/** What an agent may hand out, and whom it may touch: the rules that keep `agents` from being a way up. */
describe('what an agent may give', () => {
  it('is what it holds, never `agents` itself', () => {
    assert.deepEqual(grantableScopes(['chat', 'agents', 'run']), ['chat', 'run']);
    assert.equal(grantableScopes(DEFAULT_AGENT_SCOPES).includes('agents'), false);
  });

  it('refuses `run` to a colleague when the giver has lost it', () => {
    assert.deepEqual(scopesBeyondGrant(['chat', 'agents'], [], ['chat', 'run']), ['run']);
  });

  it('refuses a holder of everything from passing on `agents`', () => {
    assert.deepEqual(scopesBeyondGrant(DEFAULT_AGENT_SCOPES, [], ['agents']), ['agents']);
  });

  it('refuses an agent raising itself', () => {
    assert.deepEqual(scopesBeyondGrant(['chat', 'agents'], ['chat', 'agents'], ['chat', 'agents', 'run']), ['run']);
  });

  it('counts only what arrives: what a target has already stays, and taking away is free', () => {
    assert.deepEqual(scopesBeyondGrant(['chat', 'agents'], ['chat', 'agents'], ['chat', 'agents']), []);
    assert.deepEqual(scopesBeyondGrant(['chat', 'agents'], ['chat', 'agents'], []), []);
  });
});

describe('whom an agent may change', () => {
  it('not one holding a scope it lacks', () => {
    assert.deepEqual(scopesOutOfReach(['chat', 'agents'], ['chat', 'run']), ['run']);
  });

  it('itself, and anyone holding no more than it does', () => {
    assert.deepEqual(scopesOutOfReach(['chat', 'agents'], ['chat', 'agents']), []);
    assert.deepEqual(scopesOutOfReach(['chat', 'agents'], ['chat']), []);
  });
});
