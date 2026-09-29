import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  listedOfficeUrls,
  officeKey,
  readStoredHost,
  rememberOfficeLabel,
  staleTokenMessage,
  writeStoredHost,
} from '../src/host.js';

/**
 * One token per office, not one token for the app.
 *
 * A `qh_` token is minted by an office and refused by any other. Filing them
 * under a single key is how pointing this machine at a second office presented
 * the first office's credential and failed as an "auth server" error.
 */

function withDirs(run: (config: string) => void): void {
  const config = mkdtempSync(join(tmpdir(), 'quintal-hosts-'));
  const previous = {
    config: process.env.QUINTAL_CONFIG_DIR,
    token: process.env.QUINTAL_HOST_TOKEN,
    url: process.env.QUINTAL_URL,
  };
  process.env.QUINTAL_CONFIG_DIR = config;
  delete process.env.QUINTAL_HOST_TOKEN;
  delete process.env.QUINTAL_URL;
  try {
    run(config);
  } finally {
    for (const [name, value] of [
      ['QUINTAL_CONFIG_DIR', previous.config],
      ['QUINTAL_HOST_TOKEN', previous.token],
      ['QUINTAL_URL', previous.url],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('officeKey', () => {
  it('treats a trailing slash as the same office', () => {
    assert.equal(officeKey('http://localhost:3001/'), 'http://localhost:3001');
    assert.equal(officeKey('  https://office.example.com/  '), 'https://office.example.com');
  });
});

describe('a host token per office', { concurrency: false }, () => {
  it('keeps two offices apart', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_a', url: 'http://localhost:3000', label: 'laptop' });
      writeStoredHost({ token: 'qh_b', url: 'http://localhost:3001', label: 'laptop' });

      assert.equal(readStoredHost('http://localhost:3000')?.token, 'qh_a');
      assert.equal(readStoredHost('http://localhost:3001')?.token, 'qh_b');
      assert.equal(
        readStoredHost('http://localhost:3001/')?.token,
        'qh_b',
        'trailing slash is the same office',
      );
      assert.deepEqual(listedOfficeUrls(), ['http://localhost:3000', 'http://localhost:3001']);
    });
  });

  it('logging into a second office does not forget the first', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_a', url: 'http://localhost:3000' });
      writeStoredHost({ token: 'qh_b', url: 'http://localhost:3001' });
      writeStoredHost({ token: 'qh_a2', url: 'http://localhost:3000' });

      assert.equal(readStoredHost('http://localhost:3000')?.token, 'qh_a2');
      assert.equal(readStoredHost('http://localhost:3001')?.token, 'qh_b');
    });
  });

  it('a lone stored office is still what `up` finds without --url', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_only', url: 'http://office.test' });
      assert.equal(readStoredHost()?.token, 'qh_only');
      assert.equal(readStoredHost()?.url, 'http://office.test');
    });
  });

  it('two stored offices and no URL is not a guess', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_a', url: 'http://localhost:3000' });
      writeStoredHost({ token: 'qh_b', url: 'http://localhost:3001' });
      assert.equal(readStoredHost(), null);
    });
  });

  it('carries a pre-plural host.json under the URL it named', () => {
    withDirs((dir) => {
      writeFileSync(
        join(dir, 'host.json'),
        JSON.stringify({ token: 'qh_old', url: 'http://localhost:3000', label: 'Laptop' }),
      );

      const stored = readStoredHost('http://localhost:3000');
      assert.equal(stored?.token, 'qh_old');
      assert.equal(stored?.label, 'Laptop');
      assert.equal(readStoredHost('http://localhost:3001'), null);
    });
  });

  it('an env token is for QUINTAL_URL, not every office', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_file', url: 'http://localhost:3001' });
      process.env.QUINTAL_HOST_TOKEN = 'qh_env';
      process.env.QUINTAL_URL = 'http://localhost:3000';

      assert.equal(readStoredHost('http://localhost:3000')?.token, 'qh_env');
      assert.equal(readStoredHost('http://localhost:3000')?.source, 'env');
      assert.equal(
        readStoredHost('http://localhost:3001')?.token,
        'qh_file',
        'asking for another office must not inherit the env token',
      );
    });
  });

  it('refuses to write a token with no office', () => {
    withDirs(() => {
      assert.throws(() => writeStoredHost({ token: 'qh_x', url: '  ' }), /office URL/);
    });
  });

  it('the file is owner-readable only after a write', () => {
    withDirs((dir) => {
      const path = writeStoredHost({ token: 'qh_x', url: 'http://office.test' });
      assert.equal(path, join(dir, 'host.json'));
      assert.equal(statSync(path).mode & 0o777, 0o600);
    });
  });
});


/**
 * Logging in again is the recovery path, so it must not cost anything.
 *
 * The office rejects a token, you mint a new one and type
 * `quintal-acp login --token qh_new`. That used to replace the slot, silently
 * dropping the `--host` label and `--repos-dir` set months earlier — so the
 * fleet came back under a different name, in a different directory, with the
 * two facts that would explain it gone.
 */
describe('logging in again', { concurrency: false }, () => {
  it('keeps the label and repos dir when the new token brings none', () => {
    withDirs(() => {
      writeStoredHost({
        token: 'qh_old',
        url: 'https://office.example.com',
        label: 'DPR010_Office',
        reposDir: '/home/josh/code',
      });

      writeStoredHost({ token: 'qh_new', url: 'https://office.example.com' });

      const stored = readStoredHost('https://office.example.com');
      assert.equal(stored?.token, 'qh_new');
      assert.equal(stored?.label, 'DPR010_Office', 'the name survives a new token');
      assert.equal(stored?.reposDir, '/home/josh/code');
    });
  });

  it('still lets somebody change one on purpose', () => {
    withDirs(() => {
      writeStoredHost({
        token: 'qh_old',
        url: 'https://office.example.com',
        label: 'Laptop',
        reposDir: '/home/josh/code',
      });

      writeStoredHost({
        token: 'qh_new',
        url: 'https://office.example.com',
        label: 'Desktop',
      });

      const stored = readStoredHost('https://office.example.com');
      assert.equal(stored?.label, 'Desktop', 'a flag that was passed wins');
      assert.equal(stored?.reposDir, '/home/josh/code', 'one that was not is untouched');
    });
  });

  it('does not carry one office\u2019s settings into another', () => {
    withDirs(() => {
      writeStoredHost({
        token: 'qh_a',
        url: 'https://a.example.com',
        label: 'Laptop',
        reposDir: '/home/josh/code',
      });
      writeStoredHost({ token: 'qh_b', url: 'https://b.example.com' });

      const b = readStoredHost('https://b.example.com');
      assert.equal(b?.label, undefined);
      assert.equal(b?.reposDir, undefined);
    });
  });
});

/**
 * The name the office knows this machine by, written down while it is still
 * answering — because the moment it is needed is a 401, and a 401 answers
 * nothing.
 */
describe('remembering what the office calls this machine', { concurrency: false }, () => {
  it('records the name, and survives a later login', () => {
    withDirs(() => {
      writeStoredHost({ token: 'qh_old', url: 'https://office.example.com' });
      const stored = readStoredHost('https://office.example.com');
      assert.ok(stored);
      rememberOfficeLabel(stored, 'DPR010_Office');

      assert.equal(readStoredHost('https://office.example.com')?.knownAs, 'DPR010_Office');

      writeStoredHost({ token: 'qh_new', url: 'https://office.example.com' });
      assert.equal(
        readStoredHost('https://office.example.com')?.knownAs,
        'DPR010_Office',
        'the note outlives the token it was taken under — that is its whole job',
      );
    });
  });

  it('writes nothing for a machine it has no slot for', () => {
    withDirs(() => {
      rememberOfficeLabel(
        { token: 'qh_env', url: 'https://office.example.com', source: 'env' },
        'DPR010_Office',
      );
      assert.deepEqual(listedOfficeUrls(), [], 'an env token has no slot to annotate');
    });
  });

  /** A rewrite per poll is a credential file waiting to be lost to a crash. */
  it('does not rewrite the file when the name has not changed', () => {
    withDirs((config) => {
      writeStoredHost({ token: 'qh_old', url: 'https://office.example.com' });
      const stored = readStoredHost('https://office.example.com');
      assert.ok(stored);
      rememberOfficeLabel(stored, 'DPR010_Office');

      const before = statSync(join(config, 'host.json')).mtimeMs;
      rememberOfficeLabel(stored, 'DPR010_Office');
      assert.equal(statSync(join(config, 'host.json')).mtimeMs, before);
    });
  });

  it('names it in the rejection, because that is the name to re-register under', () => {
    const message = staleTokenMessage({
      token: 'qh_x',
      url: 'https://office.example.com',
      source: 'file',
      path: '/home/josh/.config/quintal/host.json',
      knownAs: 'DPR010_Office',
    });
    assert.match(message, /DPR010_Office/);
    assert.match(message, /again as `DPR010_Office`, the name its agents are assigned to/);
  });

  it('says the general thing when it never got to learn the name', () => {
    const message = staleTokenMessage({
      token: 'qh_x',
      url: 'https://office.example.com',
      source: 'file',
      path: '/home/josh/.config/quintal/host.json',
    });
    assert.match(message, /register this machine again/);
    assert.doesNotMatch(message, /the name its agents are assigned to/);
  });
});
