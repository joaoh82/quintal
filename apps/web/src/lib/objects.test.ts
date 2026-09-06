import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mayReadObject, objectUrl, uploadKeyFor } from './objects.js';

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
