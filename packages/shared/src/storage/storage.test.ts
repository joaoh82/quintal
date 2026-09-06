import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  IMAGE_TYPES,
  ObjectRejected,
  assertObjectAllowed,
  assertStorageFitForProduction,
  getStorage,
  isObjectKey,
  putReplacing,
  resolveStorage,
  sniffImageType,
  LocalObjectStore,
  S3ObjectStore,
} from './index.js';

/**
 * Somewhere to put bytes, and the ways that goes wrong.
 *
 * Two backends behind one interface, so the interface is what is tested:
 * a round trip, a missing object, a key that must not become a path, a
 * replacement that leaves nothing behind. The S3 backend is exercised
 * against a tiny server in this process — enough to prove the three
 * requests are shaped right and signed — because the alternative is a test
 * that passes without ever sending one.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('what an object key may be', () => {
  it('is namespaced, lowercase, and never a path trick', () => {
    assert.equal(isObjectKey('avatars/u1/abc.png'), true);
    assert.equal(isObjectKey('uploads/u1/2026/a-b_c.webp'), true);
    assert.equal(isObjectKey('abc.png'), false, 'a namespace is required');
    assert.equal(isObjectKey('avatars/../etc/passwd'), false);
    assert.equal(isObjectKey('avatars/.hidden'), false);
    assert.equal(isObjectKey('avatars//x'), false);
    assert.equal(isObjectKey('/avatars/x'), false);
    assert.equal(isObjectKey('Avatars/X.PNG'), false, 'case would differ between backends');
    assert.equal(isObjectKey(`avatars/${'a'.repeat(300)}`), false);
  });
});

describe('the limits every upload meets', () => {
  it('refuses what is too large or not an allowed type', () => {
    assert.throws(
      () => assertObjectAllowed(new Uint8Array(11), 'image/png', { maxBytes: 10, allowedTypes: IMAGE_TYPES }),
      (error: unknown) => error instanceof ObjectRejected && error.code === 'too_large',
    );
    assert.throws(
      () => assertObjectAllowed(PNG, 'text/html', { allowedTypes: IMAGE_TYPES }),
      (error: unknown) => error instanceof ObjectRejected && error.code === 'wrong_type',
    );
    assert.doesNotThrow(() => assertObjectAllowed(PNG, 'image/png', { allowedTypes: IMAGE_TYPES }));
  });

  it('reads what an image is from its bytes, not its label', () => {
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    assert.equal(sniffImageType(webp), 'image/webp');
    assert.equal(sniffImageType(new TextEncoder().encode('<svg onload=alert(1)>')), null);
    assert.equal(sniffImageType(new Uint8Array(0)), null);
  });
});

describe('a directory on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'quintal-objects-'));
  const store = new LocalObjectStore(root);

  it('round-trips bytes and their content type', async () => {
    await store.put('avatars/u1/a.png', PNG, { contentType: 'image/png' });
    const got = await store.get('avatars/u1/a.png');
    assert.ok(got);
    assert.deepEqual(got.body, PNG);
    assert.equal(got.contentType, 'image/png');
    assert.equal(got.size, PNG.byteLength);
  });

  it('answers null for what is not there, and false for deleting it', async () => {
    assert.equal(await store.get('avatars/u1/missing.png'), null);
    assert.equal(await store.delete('avatars/u1/missing.png'), false);
  });

  it('deletes an object and its sidecar', async () => {
    await store.put('avatars/u2/b.png', PNG, { contentType: 'image/png' });
    assert.equal(await store.delete('avatars/u2/b.png'), true);
    assert.equal(await store.get('avatars/u2/b.png'), null);
    assert.deepEqual(readdirSync(join(root, 'avatars/u2')), [], 'nothing left behind');
  });

  it('refuses a key that is not a key, before touching the disk', async () => {
    await assert.rejects(store.put('../escape', PNG, { contentType: 'image/png' }), ObjectRejected);
    await assert.rejects(store.get('avatars/../x'), ObjectRejected);
  });

  it('replaces by writing the new one, then removing the old', async () => {
    await store.put('avatars/u3/old.png', PNG, { contentType: 'image/png' });
    await putReplacing(store, 'avatars/u3/old.png', 'avatars/u3/new.png', PNG, {
      contentType: 'image/png',
    });
    assert.equal(await store.get('avatars/u3/old.png'), null, 'the old object is gone');
    assert.ok(await store.get('avatars/u3/new.png'), 'and the new one is there');

    // Replacing with the same key is just a write.
    await putReplacing(store, 'avatars/u3/new.png', 'avatars/u3/new.png', PNG, {
      contentType: 'image/png',
    });
    assert.ok(await store.get('avatars/u3/new.png'));
  });
});

describe('an S3-compatible bucket', () => {
  /** The smallest thing that speaks enough S3 to be put to, read and deleted. */
  const objects = new Map<string, { body: Buffer; type: string }>();
  const seen: Array<{ method: string; url: string; signed: boolean; type: string | undefined }> = [];
  let server: Server;
  let endpoint = '';

  before(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = req.url ?? '/';
        seen.push({
          method: req.method ?? '',
          url,
          signed: /^AWS4-HMAC-SHA256 /.test(String(req.headers.authorization ?? '')),
          type: req.headers['content-type'],
        });
        const stored = objects.get(url);
        switch (req.method) {
          case 'PUT':
            objects.set(url, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) });
            res.writeHead(200).end();
            return;
          case 'HEAD':
            res.writeHead(stored ? 200 : 404).end();
            return;
          case 'GET':
            if (!stored) {
              res.writeHead(404).end();
              return;
            }
            res.writeHead(200, { 'content-type': stored.type }).end(stored.body);
            return;
          case 'DELETE':
            objects.delete(url);
            res.writeHead(204).end();
            return;
          default:
            res.writeHead(405).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('puts, gets and deletes with signed, path-style requests', async () => {
    const store = new S3ObjectStore({
      bucket: 'quintal',
      endpoint,
      region: 'auto',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret',
    });

    await store.put('avatars/u1/a.png', PNG, { contentType: 'image/png' });
    const got = await store.get('avatars/u1/a.png');
    assert.ok(got);
    assert.deepEqual(got.body, PNG);
    assert.equal(got.contentType, 'image/png');

    assert.equal(await store.get('avatars/u1/none.png'), null);
    assert.equal(await store.delete('avatars/u1/a.png'), true);
    assert.equal(await store.delete('avatars/u1/a.png'), false, 'already gone');
    assert.equal(await store.get('avatars/u1/a.png'), null);

    assert.ok(seen.length > 0);
    assert.ok(seen.every((r) => r.url === '/quintal/avatars/u1/a.png' || r.url === '/quintal/avatars/u1/none.png'), 'bucket in the path');
    assert.ok(seen.every((r) => r.signed), 'every request carries a SigV4 signature');
    assert.equal(seen.find((r) => r.method === 'PUT')?.type, 'image/png');
  });
});

describe('choosing a backend from the environment', () => {
  it('is a directory beside the database when nothing is said', () => {
    const storage = resolveStorage({}, '/srv/quintal');
    assert.deepEqual(storage, { kind: 'local', root: '/srv/quintal/data/objects' });
  });

  it('honours a file: URL, relative to the data root', () => {
    assert.deepEqual(resolveStorage({ STORAGE_URL: 'file:./blobs' }, '/srv/q'), {
      kind: 'local',
      root: '/srv/q/blobs',
    });
    assert.deepEqual(resolveStorage({ STORAGE_URL: 'file:/var/objects' }, '/srv/q'), {
      kind: 'local',
      root: '/var/objects',
    });
  });

  it('reads an s3:// bucket with its endpoint and credentials', () => {
    const storage = resolveStorage({
      STORAGE_URL: 's3://avatars',
      S3_ENDPOINT: 'https://s3.example.com/',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    });
    assert.deepEqual(storage, {
      kind: 's3',
      config: { bucket: 'avatars', endpoint: 'https://s3.example.com/', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' },
    });
  });

  it('names what is missing rather than failing on the first request', () => {
    assert.throws(
      () => resolveStorage({ STORAGE_URL: 's3://avatars', S3_ENDPOINT: 'https://x' }),
      /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
    );
    assert.throws(() => resolveStorage({ STORAGE_URL: 'gs://nope' }), /expected file:<dir> or s3:/);
    assert.throws(() => resolveStorage({ STORAGE_URL: 's3://a/b' }), /expected s3:\/\/<bucket>/);
  });
});

describe('refusing a disk that will not be there tomorrow', () => {
  const local = { kind: 'local' as const, root: '/tmp/x' };
  const bucket = { kind: 's3' as const, config: { bucket: 'b', endpoint: 'e', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' } };

  it('stops a production boot on local storage, unless told the disk is real', () => {
    assert.throws(() => assertStorageFitForProduction(local, { NODE_ENV: 'production' }), /STORAGE_URL=s3:/);
    assert.doesNotThrow(() => assertStorageFitForProduction(local, { NODE_ENV: 'production', STORAGE_ALLOW_LOCAL: '1' }));
  });

  it('lets development, a build, and a bucket through', () => {
    assert.doesNotThrow(() => assertStorageFitForProduction(local, { NODE_ENV: 'development' }));
    assert.doesNotThrow(() => assertStorageFitForProduction(local, {}));
    assert.doesNotThrow(() =>
      assertStorageFitForProduction(local, { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }),
    );
    assert.doesNotThrow(() => assertStorageFitForProduction(bucket, { NODE_ENV: 'production' }));
  });
});

describe('opening the process store', () => {
  it('runs the production guard on first use, not only at server boot', () => {
    const before = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.STORAGE_URL;
      delete process.env.STORAGE_ALLOW_LOCAL;
      delete process.env.NEXT_PHASE;
      assert.throws(() => getStorage(), /STORAGE_URL=s3:/);
    } finally {
      process.env = before;
    }
  });
});
