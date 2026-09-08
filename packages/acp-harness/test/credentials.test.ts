import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { generateSecretKey, getPublicKeyHex, nsecEncode } from '@quintal/shared';

import { ConfigError, parseFleet } from '../src/config.js';
import { AGENT_KEYS_ENV, credentialFor, readAgentKeyMap } from '../src/credential.js';
import { noteSecretEnv, redactSecrets, scrubbedEnv, secretEnvNames } from '../src/secrets.js';

/** The error a call threw, failing loudly if it did not throw. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error: unknown) {
    return error as Error;
  }
  throw new assert.AssertionError({ message: 'expected a throw' });
}

/**
 * Which credential an agent presents, and the two places a key must never go.
 *
 * The rules are small and every one of them is a way a secret leaks: a key
 * mistaken for another kind, a variable the runtime inherits, an error that
 * quotes the thing that was wrong.
 */

const secretKey = generateSecretKey();
const nsec = nsecEncode(secretKey);
const pubkey = getPublicKeyHex(secretKey);

describe('which credential an agent presents', () => {
  it('prefers its own key over a host token, and never sends both', () => {
    const credential = credentialFor({ name: 'buzz', key: nsec, hostToken: 'qh_x', agentId: 'a1' });
    assert.equal(credential.kind, 'keypair');
    if (credential.kind === 'keypair') assert.equal(credential.pubkey, pubkey);
  });

  it('accepts the key as hex too', () => {
    const hex = Buffer.from(secretKey).toString('hex');
    const credential = credentialFor({ name: 'buzz', key: hex });
    assert.equal(credential.kind, 'keypair');
    if (credential.kind === 'keypair') assert.equal(credential.pubkey, pubkey);
  });

  it('falls back to the host token for an office-defined agent without a key', () => {
    assert.deepEqual(credentialFor({ name: 'buzz', key: '', hostToken: 'qh_x', agentId: 'a1' }), {
      kind: 'host',
      token: 'qh_x',
      agentId: 'a1',
    });
  });

  it('still carries a legacy key', () => {
    assert.deepEqual(credentialFor({ name: 'buzz', key: 'qa_abc' }), { kind: 'key', key: 'qa_abc' });
  });

  it('refuses a key it cannot read, without repeating it', () => {
    const bad = nsec.slice(0, -3) + 'xyz';
    const error = thrown(() => credentialFor({ name: 'buzz', key: bad }));
    assert.ok(error instanceof ConfigError);
    assert.doesNotMatch(error.message, new RegExp(bad.slice(5, 20)));
    assert.throws(() => credentialFor({ name: 'buzz', key: 'hunter2' }), ConfigError);
    assert.throws(() => credentialFor({ name: 'buzz', key: '' }), ConfigError);
  });
});

describe('the fleet file', () => {
  it('takes an nsec where a qa_ key used to go', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-fleet-'));
    const fleet = parseFleet(
      { agents: [{ name: 'buzz', key: nsec, agent: 'custom', cmd: 'node x', cwd: dir }] },
      dir,
    );
    assert.equal(fleet.agents[0]!.key, nsec);
    assert.equal(credentialFor(fleet.agents[0]!).kind, 'keypair');
  });

  it('remembers which variable a keyEnv came from, so the runtime never sees it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-fleet-'));
    process.env.BUZZ_KEY = nsec;
    try {
      parseFleet({ agents: [{ name: 'buzz', keyEnv: 'BUZZ_KEY', agent: 'custom', cmd: 'node x', cwd: dir }] }, dir);
      assert.ok(secretEnvNames().includes('BUZZ_KEY'));
      assert.equal(scrubbedEnv(process.env).BUZZ_KEY, undefined);
    } finally {
      delete process.env.BUZZ_KEY;
    }
  });
});

describe(AGENT_KEYS_ENV, () => {
  it('is a map of agent id to secret key', () => {
    const keys = readAgentKeyMap({ [AGENT_KEYS_ENV]: JSON.stringify({ a1: nsec }) });
    assert.equal(keys.get('a1'), nsec);
    assert.equal(readAgentKeyMap({}).size, 0);
  });

  it('names the variable and the agent, never the value, when it is wrong', () => {
    const notJson = thrown(() => readAgentKeyMap({ [AGENT_KEYS_ENV]: '{' }));
    assert.match(notJson.message, /QUINTAL_AGENT_KEYS/);
    const badKey = thrown(() =>
      readAgentKeyMap({ [AGENT_KEYS_ENV]: JSON.stringify({ a1: 'nsec1notakey' }) }),
    );
    assert.match(badKey.message, /agent a1/);
    assert.doesNotMatch(badKey.message, /notakey/);
    assert.throws(() => readAgentKeyMap({ [AGENT_KEYS_ENV]: '[]' }), ConfigError);
  });
});

describe('what the runtime inherits', () => {
  it('is our environment minus every credential', () => {
    noteSecretEnv('MY_AGENT_KEY');
    const env = scrubbedEnv({
      PATH: '/usr/bin',
      QUINTAL_AGENT_KEYS: '{}',
      QUINTAL_HOST_TOKEN: 'qh_x',
      AGENT_KEY: 'qa_x',
      MY_AGENT_KEY: nsec,
    });
    assert.deepEqual(env, { PATH: '/usr/bin' });
  });
});

describe('what a log line may say', () => {
  it('blanks secrets by shape and leaves public keys alone', () => {
    const line = `agent buzz (${pubkey}) failed: key ${nsec} rejected, token qh_abcdefgh12 and qa_zyxwvuts98 too`;
    const redacted = redactSecrets(line);
    assert.doesNotMatch(redacted, new RegExp(nsec.slice(5, 25)));
    assert.doesNotMatch(redacted, /qh_abcdefgh12|qa_zyxwvuts98/);
    assert.match(redacted, new RegExp(pubkey));
    assert.match(redacted, /nsec1…/);
  });
});
