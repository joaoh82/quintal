import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUNTIMES, acpCommandFor } from '@quintal/shared';

import { toAgentConfigs } from '../src/host.js';
import {
  CUSTOM_HARNESS,
  KNOWN_HARNESSES,
  defaultCommandFor,
  isHarness,
} from '../src/config.js';

/**
 * One catalogue, one answer.
 *
 * This list was hand-maintained once and drifted: the office listed `gemini`,
 * `opencode` and `omp` as usable while the harness had never heard of them, so
 * the settings page said "ready" and the spawn said "unknown harness". Nothing
 * caught it, because both halves were internally consistent — they simply
 * disagreed with each other.
 */
describe('the harness and the office agree on what can be run', () => {
  const usable = RUNTIMES.filter((runtime) => runtime.acp.kind !== 'none');

  it('can launch every runtime the office calls usable', () => {
    for (const runtime of usable) {
      assert.ok(
        isHarness(runtime.id),
        `the office offers ${runtime.id} but the harness cannot launch it`,
      );
    }
  });

  it('launches each one with the command the catalogue specifies', () => {
    for (const runtime of usable) {
      assert.deepEqual(
        defaultCommandFor(runtime.id),
        acpCommandFor(runtime),
        `${runtime.id} would be spawned with a command the office did not choose`,
      );
    }
  });

  it('refuses a runtime that has no ACP mode', () => {
    for (const runtime of RUNTIMES.filter((r) => r.acp.kind === 'none')) {
      assert.equal(
        isHarness(runtime.id),
        false,
        `${runtime.id} cannot speak ACP, so it must not look launchable`,
      );
    }
  });

  it('offers nothing the catalogue does not, beyond the custom escape hatch', () => {
    const ids = new Set(RUNTIMES.map((runtime) => runtime.id));
    for (const harness of KNOWN_HARNESSES) {
      if (harness === CUSTOM_HARNESS) continue;
      assert.ok(ids.has(harness), `${harness} is offered but is in no catalogue`);
    }
  });

  it('still requires a command for the custom harness', () => {
    assert.throws(() => defaultCommandFor(CUSTOM_HARNESS), /requires an explicit cmd/);
  });
});

/**
 * An agent works where its owner said, and its owner said "under here".
 *
 * `repoSpec` is the only office-controlled value in a fleet that is not a
 * catalogue id, and both `~` and a leading `/` walk straight out of the repos
 * directory. Not a privilege boundary — it is the owner's own config — but the
 * blast radius of a typo or a compromised office should stop at the directory
 * they nominated.
 */
describe('where an agent is allowed to work', () => {
  const host = { token: 'qh_x', url: 'http://localhost:3000' };
  const fleet = (repoSpec: string) => ({
    host: { label: 'laptop', owner: 'Josh', workspaceId: 'ws_test' },
    agents: [{ agentId: 'a1', name: 'Bob', runtimeId: 'omp', repoSpec, profile: 'p1' }],
  });

  it('accepts a repo under the repos directory', () => {
    const { agents, skipped } = toAgentConfigs(fleet('quintal'), host, '/repos', 'hq');
    assert.equal(skipped.length, 0);
    assert.equal(agents[0]?.cwd, '/repos/quintal');
  });

  it('accepts the whole repos directory', () => {
    const { agents } = toAgentConfigs(fleet('*'), host, '/repos', 'hq');
    assert.equal(agents[0]?.cwd, '/repos');
    assert.equal(agents[0]?.rootedAtReposDir, true);
  });

  for (const escape of ['/etc', '../secrets', 'a/../../b', '~']) {
    it(`refuses "${escape}", which leaves the repos directory`, () => {
      const { agents, skipped } = toAgentConfigs(fleet(escape), host, '/repos', 'hq');
      assert.equal(agents.length, 0, `${escape} must not become a workspace`);
      assert.equal(skipped.length, 1);
      assert.match(skipped[0]!.why, /outside/);
    });
  }

  it('does not mistake a sibling directory for a child', () => {
    const { agents, skipped } = toAgentConfigs(fleet('../repos-elsewhere'), host, '/repos', 'hq');
    assert.equal(agents.length, 0, '/repos-elsewhere only shares a prefix');
    assert.equal(skipped.length, 1);
  });
});
