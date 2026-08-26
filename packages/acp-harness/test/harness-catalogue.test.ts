import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUNTIMES, acpCommandFor } from '@quintal/shared';

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
