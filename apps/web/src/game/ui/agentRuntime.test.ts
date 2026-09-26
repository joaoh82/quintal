import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RosterEntry } from '@quintal/shared';

import { runtimeLines } from './agentRuntime.js';

/**
 * The card says what an agent runs on, and says nothing when the office was
 * not the one that decided. Both halves matter: a wrong runtime on a card is
 * worse than no runtime, because somebody will act on it.
 */

function entry(over: Partial<RosterEntry>): RosterEntry {
  return {
    sessionId: 's',
    name: 'Bob',
    kind: 'agent',
    status: '',
    isSelf: false,
    ownerName: 'Josh',
    ownerUserId: 'u1',
    scopes: [],
    runtimeId: '',
    modelId: '',
    identityId: 'a1',
    lastActionAt: 0,
    avatar: '',
    isGuest: false,
    description: '',
    pubkey: '',
    zoneId: 'agent-bay',
    emote: '',
    workingIn: '',
    workingSince: 0,
    ...over,
  };
}

describe('what an agent runs on', () => {
  it('names the runtime the way the catalogue does', () => {
    assert.deepEqual(runtimeLines(entry({ runtimeId: 'claude-code', modelId: 'opus' })), {
      runtime: 'Claude Code',
      model: 'opus',
    });
  });

  it('prints an unknown runtime id as itself', () => {
    // A fleet file written against a newer catalogue, or one dropped from it:
    // the id is still the truest thing the office has to say.
    assert.deepEqual(runtimeLines(entry({ runtimeId: 'something-else' })), {
      runtime: 'something-else',
      model: 'default',
    });
  });

  it("calls an unchosen model the runtime's default", () => {
    assert.equal(runtimeLines(entry({ runtimeId: 'goose', modelId: '' }))?.model, 'default');
  });

  it('says nothing about an agent the office does not define', () => {
    assert.equal(runtimeLines(entry({ runtimeId: '', modelId: '' })), null);
  });

  it('says nothing about a person', () => {
    assert.equal(runtimeLines(entry({ kind: 'human', runtimeId: 'claude-code' })), null);
  });
});
