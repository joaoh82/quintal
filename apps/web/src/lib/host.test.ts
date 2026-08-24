import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  describeHostFailure,
  getHost,
  hasHost,
  hostPromptFor,
  resetHostForTests,
  type HostBridge,
} from './host';

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

describe('hostPromptFor', () => {
  const base = { hosted: true, asking: false, state: null, error: null } as const;

  it('offers the browser paths when there is no host', () => {
    assert.deepEqual(
      hostPromptFor({ ...base, hosted: false }),
      { kind: 'browser' },
    );
  });

  it('waits while the host is still being asked', () => {
    assert.deepEqual(hostPromptFor({ ...base, asking: true }), { kind: 'asking' });
  });

  it('maps each answer the host can actually give', () => {
    assert.deepEqual(hostPromptFor({ ...base, state: 'ready' }), { kind: 'ready' });
    assert.deepEqual(hostPromptFor({ ...base, state: 'none' }), { kind: 'create' });
    assert.deepEqual(hostPromptFor({ ...base, state: 'locked' }), { kind: 'locked' });
  });

  it('does not call a failed question a locked keychain', () => {
    // The bug this exists for. `hasIdentity` cannot fail on the Rust side, so a
    // rejection means the call never landed — and rendering "this computer is
    // holding your key, do not create a new identity" on the back of that is a
    // false claim that also disables the way out.
    const prompt = hostPromptFor({ ...base, error: 'ipc unavailable' });
    assert.equal(prompt.kind, 'unreachable');
    assert.notEqual(prompt.kind, 'locked');
    assert.match(prompt.kind === 'unreachable' ? prompt.message : '', /ipc unavailable/);
  });

  it('prefers the error over a stale state', () => {
    // If the last answer was `ready` and the next call failed, we no longer
    // know; saying "continue with this computer's key" would offer a button
    // that cannot work.
    assert.equal(
      hostPromptFor({ ...base, state: 'ready', error: 'gone' }).kind,
      'unreachable',
    );
  });

  it('never guesses locked from an absent answer', () => {
    assert.equal(hostPromptFor({ ...base, state: null }).kind, 'unreachable');
  });
});

describe('describeHostFailure', () => {
  it('keeps a plain string, which is how an ACL refusal arrives', () => {
    // The real one. Tauri rejects with the value, not an Error, so the
    // `instanceof Error` check discarded precisely the useful message.
    const refusal = 'has_identity not allowed on window "main", URL: local';
    assert.equal(describeHostFailure(refusal), refusal);
  });

  it('reads a HostError from the Rust side', () => {
    assert.equal(
      describeHostFailure({ code: 'locked', message: 'the keychain would not unlock' }),
      'the keychain would not unlock',
    );
  });

  it('reads an ordinary Error', () => {
    assert.equal(describeHostFailure(new Error('boom')), 'boom');
  });

  it('does not swallow an object with no message', () => {
    assert.match(describeHostFailure({ weird: true }), /weird/);
  });

  it('says so plainly when there is genuinely nothing', () => {
    for (const nothing of [undefined, null, '', new Error('')]) {
      assert.match(describeHostFailure(nothing), /no reason/);
    }
  });
});
