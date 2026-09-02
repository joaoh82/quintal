import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentConfig } from '../src/config.js';
import { sameAgent } from '../src/supervisor.js';

/**
 * When a running agent has to be restarted.
 *
 * `reconcile` leaves an agent alone when this says nothing changed, so what it
 * compares decides what an owner can actually edit. It used to compare only the
 * spawn arguments, which had two symptoms that looked unrelated:
 *
 * Editing an agent's instructions did nothing to a running agent, because it is
 * told what it is in `agent:ready` — at connect — and nothing ever reconnected
 * it.
 *
 * And the obvious workaround made it worse. Disabling an agent and enabling it
 * again inside one 15s poll left the fleet list unchanged between polls, so the
 * launch matched and the agent kept running with the old instructions. Toggling
 * it looked like doing something and was doing nothing.
 */

const base: AgentConfig = {
  name: 'Marvin',
  key: '',
  hostToken: 'qh_x',
  agentId: 'a1',
  harness: 'custom',
  command: ['claude', 'acp'],
  cwd: '/repos/quintal',
  rootedAtReposDir: false,
  url: 'http://localhost:3000',
  mapId: 'hq',
  workspaceId: 'ws-1',
  profile: 'abc123',
} as unknown as AgentConfig;

const withChange = (change: Partial<AgentConfig>): AgentConfig =>
  ({ ...base, ...change }) as AgentConfig;

describe('deciding whether a running agent still matches the office', () => {
  it('leaves an unchanged agent alone', () => {
    assert.equal(sameAgent(base, withChange({})), true);
  });

  /** The bug: an edited profile has to reach a running agent. */
  it('restarts one whose owner rewrote its instructions', () => {
    assert.equal(
      sameAgent(base, withChange({ profile: 'def456' })),
      false,
      'a running agent keeps what it was told at connect until something reconnects it',
    );
  });

  it('still restarts on the things it always did', () => {
    assert.equal(sameAgent(base, withChange({ cwd: '/repos/other' })), false);
    assert.equal(sameAgent(base, withChange({ url: 'http://elsewhere' })), false);
    assert.equal(sameAgent(base, withChange({ mapId: 'annex' })), false);
    assert.equal(sameAgent(base, withChange({ command: ['codex', 'acp'] })), false);
  });

  /**
   * A standalone `--agent` run has no office profile, so every one of them
   * carries an empty fingerprint. That must read as "unchanged", not as "always
   * different" — otherwise reconcile would restart it on every poll.
   */
  it('does not churn an agent that has no profile to compare', () => {
    const solo = withChange({ profile: '' });
    assert.equal(sameAgent(solo, withChange({ profile: '' })), true);
  });
});
