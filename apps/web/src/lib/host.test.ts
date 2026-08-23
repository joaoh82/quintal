import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getHost, hasHost, resetHostForTests, type HostBridge } from './host';

/**
 * Whether the app is hosted, and what happens when it is not.
 *
 * The consequences run in both directions. Deciding "no host" inside the
 * desktop app means the key in the OS keychain is never reached and the user is
 * asked to paste an nsec instead. Deciding "host" in a browser means calling
 * IPC that does not exist, and a control that throws rather than explaining
 * itself. So detection is a feature test, and its failure mode is a documented
 * null rather than a guess.
 */

const win = globalThis as { window?: { __TAURI_INTERNALS__?: unknown } };

function withWindow(value: Record<string, unknown> | undefined): void {
  if (value === undefined) delete win.window;
  else win.window = value;
  resetHostForTests(undefined);
}

afterEach(() => {
  withWindow(undefined);
});

describe('hasHost', () => {
  it('is false with no window at all, as on the server', () => {
    withWindow(undefined);
    assert.equal(hasHost(), false);
    assert.equal(getHost(), null);
  });

  it('is false in a plain browser', () => {
    withWindow({});
    assert.equal(hasHost(), false);
    assert.equal(getHost(), null);
  });

  it('is true when the host has injected its internals', () => {
    withWindow({ __TAURI_INTERNALS__: { invoke: () => {} } });
    assert.equal(hasHost(), true);
    assert.ok(getHost());
  });

  it('does not consult the user agent', () => {
    // A user agent is a claim any page can make, and "Quintal" appearing in one
    // must never be what decides that IPC exists.
    withWindow({ navigator: { userAgent: 'Quintal Desktop/1.0 Tauri' } });
    assert.equal(hasHost(), false, 'a string is not a capability');
  });
});

describe('getHost', () => {
  it('exposes the whole interface when hosted', () => {
    withWindow({ __TAURI_INTERNALS__: {} });
    const host = getHost();
    assert.ok(host);
    for (const method of [
      'hasIdentity',
      'getPublicKey',
      'signChallenge',
      'importIdentity',
      'exportBackup',
      'confirmBackup',
      'canWipe',
      'wipeIdentity',
    ] as const) {
      assert.equal(typeof host[method], 'function', `${method} is missing`);
    }
  });

  it('answers the same object every time, so callers can compare it', () => {
    withWindow({ __TAURI_INTERNALS__: {} });
    assert.equal(getHost(), getHost());
  });

  it('can be replaced wholesale for a test', () => {
    const fake = { getPublicKey: async () => 'ab'.repeat(32) } as unknown as HostBridge;
    resetHostForTests(fake);
    assert.equal(getHost(), fake);
  });
});

describe('a host identity holds no secret', () => {
  it('is never a candidate for browser storage', async () => {
    // The storage rule is keyed on `kind === 'local'`. A host identity has no
    // nsec to save and none to destroy, so both branches must decline — saving
    // would write `undefined`, and forgetting would delete a *different*
    // identity that happens to be in this browser.
    const { storageActionFor } = await import('./keys');
    for (const persist of [true, false]) {
      for (const saved of [null, 'nsec1whatever']) {
        assert.equal(
          storageActionFor({ identity: { kind: 'host' }, persist, saved }),
          'leave',
        );
      }
    }
  });
});
