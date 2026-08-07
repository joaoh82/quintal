import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decoder, Encoder } from '@colyseus/schema';

import { OfficePlayer, OfficeState, createPlayer } from './state.js';

/**
 * Schema state fails *silently* when it fails: a field defined as an own
 * property shadows the change-tracking accessor on the prototype, the server
 * happily mutates it, and no patch ever reaches the client. There is no error
 * to notice. These tests exist so the next person to touch `state.ts` — or the
 * tsconfig it depends on — finds out immediately.
 */

/** Encode a state and decode it into a fresh instance, as a client would. */
function roundTrip(state: OfficeState): OfficeState {
  const encoder = new Encoder(state);
  const decoded = new OfficeState();
  const decoder = new Decoder(decoded);
  decoder.decode(encoder.encodeAll());
  return decoded;
}

describe('OfficePlayer', () => {
  it('keeps its fields on the prototype, not as own properties', () => {
    const player = new OfficePlayer();
    for (const field of ['userId', 'name', 'x', 'y', 'dir', 'moving', 'kind']) {
      const own = Object.getOwnPropertyDescriptor(player, field);
      assert.equal(
        own?.get === undefined && own?.value !== undefined,
        false,
        `"${field}" is an own data property — it shadows schema's accessor and will never sync`,
      );
    }
  });

  it('defaults to a human', () => {
    assert.equal(new OfficePlayer().kind, 'human');
  });
});

describe('state sync', () => {
  it('round-trips a player through encode/decode', () => {
    const state = new OfficeState();
    state.players.set(
      'abc',
      createPlayer({ userId: 'u1', name: 'Ada', x: 656, y: 496, kind: 'human' }),
    );

    const decoded = roundTrip(state);
    const player = decoded.players.get('abc');

    assert.ok(player, 'player did not survive the round trip');
    assert.equal(player.name, 'Ada');
    assert.equal(player.userId, 'u1');
    assert.equal(player.x, 656);
    assert.equal(player.y, 496);
    assert.equal(player.kind, 'human');
    assert.equal(player.dir, 'down');
    assert.equal(player.moving, false);
  });

  it('carries agents through the same path as humans', () => {
    const state = new OfficeState();
    state.players.set(
      'agent-1',
      createPlayer({
        userId: 'a1',
        name: 'reviewer',
        x: 32,
        y: 32,
        kind: 'agent',
        status: 'running tests',
      }),
    );

    const player = roundTrip(state).players.get('agent-1');
    assert.equal(player?.kind, 'agent');
    assert.equal(player?.status, 'running tests');
  });

  it('propagates a mutation as a patch, not just on full encode', () => {
    const state = new OfficeState();
    state.players.set('abc', createPlayer({ userId: 'u1', name: 'Ada', x: 0, y: 0 }));

    const encoder = new Encoder(state);
    const client = new OfficeState();
    const decoder = new Decoder(client);
    decoder.decode(encoder.encodeAll());

    // Exactly what the simulation does every tick.
    const server = state.players.get('abc');
    assert.ok(server);
    server.x = 128;
    server.moving = true;
    server.dir = 'right';

    decoder.decode(encoder.encode());
    encoder.discardChanges();

    const mirrored = client.players.get('abc');
    assert.equal(mirrored?.x, 128, 'position change never reached the client');
    assert.equal(mirrored?.moving, true);
    assert.equal(mirrored?.dir, 'right');
  });

  it('removes a player from the client when the server deletes them', () => {
    const state = new OfficeState();
    state.players.set('abc', createPlayer({ userId: 'u1', name: 'Ada', x: 0, y: 0 }));

    const encoder = new Encoder(state);
    const client = new OfficeState();
    const decoder = new Decoder(client);
    decoder.decode(encoder.encodeAll());
    encoder.discardChanges();

    state.players.delete('abc');
    decoder.decode(encoder.encode());

    assert.equal(client.players.size, 0);
  });
});
