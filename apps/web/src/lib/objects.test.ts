import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mayReadObject, objectUrl, readBounded, uploadKeyFor } from './objects.js';

/**
 * An unguessable key is not access control. These pin who may read what,
 * by namespace, before any bytes are served.
 */
describe('who may read an object', () => {
  const josh = { user: { id: 'u-josh' }, session: { isGuest: false } };
  const ana = { user: { id: 'u-ana' }, session: { isGuest: false } };
  const guest = { user: { id: 'u-guest' }, session: { isGuest: true } };

  it('shows a face to anyone signed in, guests included', () => {
    assert.equal(mayReadObject(josh, 'avatars/u-ana/a.png'), true);
    assert.equal(mayReadObject(guest, 'avatars/u-ana/a.png'), true);
  });

  it('shows an upload only to whoever made it', () => {
    assert.equal(mayReadObject(josh, uploadKeyFor('u-josh', 'x', 'png')), true);
    assert.equal(mayReadObject(ana, uploadKeyFor('u-josh', 'x', 'png')), false);
    assert.equal(mayReadObject(guest, uploadKeyFor('u-guest', 'x', 'png')), false, 'a guest has no uploads');
  });

  it('refuses a namespace nobody has defined', () => {
    assert.equal(mayReadObject(josh, 'secrets/u-josh/x'), false);
    assert.equal(mayReadObject(josh, ''), false);
  });

  it('serves objects under one path', () => {
    assert.equal(objectUrl('avatars/u1/a.png'), '/api/objects/avatars/u1/a.png');
  });
});

describe('reading an upload no further than the cap', () => {
  /** A request whose body arrives in chunks, with no Content-Length at all. */
  function streaming(chunks: number[][]): { request: Request; pulled: () => number } {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[pulled];
        if (next === undefined) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(new Uint8Array(next));
      },
    });
    return {
      request: new Request('http://x/api/objects', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      pulled: () => pulled,
    };
  }

  it('assembles a body that fits', async () => {
    const { request } = streaming([[1, 2, 3], [4, 5]]);
    assert.deepEqual(await readBounded(request, 10), new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('stops reading at the byte after the cap, whatever the header said', async () => {
    const { request, pulled } = streaming([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]);
    assert.equal(await readBounded(request, 5), null);
    assert.equal(pulled(), 2, 'the rest of the body was never pulled');
  });

  it('takes exactly the cap', async () => {
    const { request } = streaming([[1, 2], [3, 4, 5]]);
    assert.equal((await readBounded(request, 5))?.byteLength, 5);
  });

  it('treats no body as empty', async () => {
    assert.deepEqual(await readBounded(new Request('http://x', { method: 'POST' }), 5), new Uint8Array(0));
  });
});
