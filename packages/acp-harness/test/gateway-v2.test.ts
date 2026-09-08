import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  generateSecretKey,
  getPublicKeyHex,
  parseAuthPayload,
  verifyAuthSignature,
  buildAuthPayload,
} from '@quintal/shared';
import type { Room } from 'colyseus.js';

import { credentialFor } from '../src/credential.js';
import { GatewayClient } from '../src/gateway/client.js';

/**
 * The door, from the harness's side: what it asks for, what it signs, what it
 * presents. No office — a `fetch` that issues challenges and a `join` that
 * records the options are the whole network.
 */

const ORIGIN = 'https://office.example.test';
const secretKey = generateSecretKey();
const pubkey = getPublicKeyHex(secretKey);
const nsec = Buffer.from(secretKey).toString('hex');

interface World {
  client: GatewayClient;
  challenges: string[];
  joins: Record<string, unknown>[];
  officeCalls: { body: unknown; auth: string | null }[];
}

function world(credential: Parameters<typeof credentialFor>[0], workspaceId = 'ws-1'): World {
  const challenges: string[] = [];
  const joins: Record<string, unknown>[] = [];
  const officeCalls: { body: unknown; auth: string | null }[] = [];

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/agent/challenge')) {
      const nonce = randomBytes(32).toString('hex');
      challenges.push(nonce);
      return Response.json({ nonce, origin: ORIGIN, expiresInMs: 60_000 });
    }
    if (url.endsWith('/api/agent/office')) {
      const headers = new Headers(init?.headers);
      officeCalls.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        auth: headers.get('authorization'),
      });
      return Response.json({ workspaceId: 'ws-from-office' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  const fakeJoin = async (_endpoint: string, options: Record<string, unknown>) => {
    joins.push(options);
    const handlers = new Map<string, (payload: unknown) => void>();
    const room = {
      sessionId: 's1',
      onMessage: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
      },
      onLeave: () => undefined,
      send: () => undefined,
      leave: async () => undefined,
    };
    // The office greets an agent the moment it is in — after the client has
    // had its turn to register handlers, as a real socket would.
    setTimeout(() => handlers.get('agent:ready')?.({ agentId: 'a1', channels: [] }), 0);
    return room as unknown as Room;
  };

  const client = new GatewayClient('https://office.example.test', credentialFor(credential), 'hq', workspaceId, {
    fetch: fakeFetch,
    join: fakeJoin,
  });
  return { client, challenges, joins, officeCalls };
}

describe('joining with its own key', () => {
  it('presents a freshly signed challenge and nothing else', async () => {
    const w = world({ name: 'buzz', key: nsec, hostToken: 'qh_x', agentId: 'a1' });
    await w.client.connect();

    assert.equal(w.challenges.length, 1, 'one challenge per connect');
    const join = w.joins[0]!;
    assert.equal(join.agentPubkey, pubkey);
    assert.equal(join.nonce, w.challenges[0]);
    assert.equal(join.hostToken, undefined, 'the host token stays home');
    assert.equal(join.agentKey, undefined);
    assert.equal(join.workspaceId, 'ws-1');

    // The signature is over the payload the office will rebuild: its origin,
    // its nonce, our clock.
    const payload = buildAuthPayload({
      origin: ORIGIN,
      nonce: String(join.nonce),
      timestamp: Number(join.timestamp),
    });
    assert.ok(parseAuthPayload(payload));
    assert.equal(verifyAuthSignature({ pubkey, sig: String(join.sig), payload }), true);
  });

  it('asks for a new challenge on every connect', async () => {
    const w = world({ name: 'buzz', key: nsec });
    await w.client.connect();
    await w.client.leave();
    await w.client.connect();
    assert.equal(w.challenges.length, 2);
    assert.notEqual(w.joins[0]!.nonce, w.joins[1]!.nonce);
  });

  it('finds its office with a signed challenge, not a bearer secret', async () => {
    const w = world({ name: 'buzz', key: nsec }, '');
    await w.client.connect();
    assert.equal(w.officeCalls.length, 1);
    assert.equal(w.officeCalls[0]!.auth, null);
    const proof = w.officeCalls[0]!.body as Record<string, unknown>;
    assert.equal(proof.agentPubkey, pubkey);
    assert.equal(w.joins[0]!.workspaceId, 'ws-from-office');
    // Two challenges: one spent on the lookup, one on the door.
    assert.equal(w.challenges.length, 2);
    assert.notEqual(proof.nonce, w.joins[0]!.nonce);
  });

  it('fails on a bad key before anything is asked of the office', async () => {
    assert.throws(() => credentialFor({ name: 'buzz', key: 'nsec1nope' }));
  });
});

describe('the older doors', () => {
  it('a host token still names the agent', async () => {
    const w = world({ name: 'buzz', key: '', hostToken: 'qh_x', agentId: 'a1' });
    await w.client.connect();
    assert.equal(w.challenges.length, 0);
    assert.deepEqual(
      { hostToken: w.joins[0]!.hostToken, agentId: w.joins[0]!.agentId, agentPubkey: w.joins[0]!.agentPubkey },
      { hostToken: 'qh_x', agentId: 'a1', agentPubkey: undefined },
    );
  });

  it('a legacy key still looks its office up by bearer', async () => {
    const w = world({ name: 'buzz', key: 'qa_abc' }, '');
    await w.client.connect();
    assert.equal(w.officeCalls[0]!.auth, 'Bearer qa_abc');
    assert.equal(w.joins[0]!.agentKey, 'qa_abc');
    assert.equal(w.challenges.length, 0);
  });
});
