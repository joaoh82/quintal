import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  listedOfficeUrls,
  officeKey,
  readStoredHost,
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
