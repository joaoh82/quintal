import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { fetchFleet, type StoredHost } from '../src/host.js';

/**
 * A rejected token has two causes and one status code.
 *
 * The message is the whole feature here: 401 means "revoked" or it means "this
 * token outlived the database that issued it", and only the second is common in
 * development. Sending somebody to /settings/agents for an orphaned token wastes
 * a round trip, which is exactly how this was found.
 */
/** The error a call rejected with, failing loudly if it did not reject. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as Error;
  }
  throw new assert.AssertionError({ message: 'expected the office to be refused' });
}

describe('a host token the office turns down', () => {
  const realFetch = globalThis.fetch;
  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response('', { status: 401 })) as typeof globalThis.fetch;
  });

  const base: StoredHost = { token: 'qh_abc', url: 'http://localhost:3000' };

  it('names the file and when it was written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-host-'));
    const path = join(dir, 'host.json');
    writeFileSync(path, '{}');
    const written = new Date('2026-08-08T07:57:50Z');
    utimesSync(path, written, written);

    const error = await rejection(
      fetchFleet({ ...base, source: 'file', path, writtenAt: written }, null),
    );

    assert.match(error.message, /host\.json/, 'says which file to fix');
    assert.match(error.message, /2026-08-08/, 'dates it, so an orphan is obvious');
    assert.match(error.message, /recreated/, 'offers the common cause');
  });

  it('names the variable when the token came from the environment', async () => {
    const error = await rejection(fetchFleet({ ...base, source: 'env' }, null));

    assert.match(error.message, /QUINTAL_HOST_TOKEN/);
    assert.doesNotMatch(error.message, /host\.json/, 'no file is involved');
  });

  it('still refuses a token that is not one before asking the office', async () => {
    const error = await rejection(fetchFleet({ ...base, token: 'nope' }, null));
    assert.match(error.message, /starts with/);
  });
});
