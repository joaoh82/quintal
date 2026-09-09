import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import {
  VOICE_CLOSE,
  VOICE_HEADER_BYTES,
  VOICE_PATH,
  packVoiceHeader,
  parseVoiceHeader,
  type VoiceServerMessage,
} from '@quintal/shared';
import { WebSocket } from 'ws';

import { VoiceRelay, type VoicePresence } from './relay.js';

/**
 * The relay, driven by a headless client that speaks the protocol with
 * synthetic frames and no microphone.
 *
 * What is proved here is the property the design rests on: receipt is the
 * server's decision. A client outside the set gets nothing; an agent is
 * never a peer; a strange header is forwarded, not dropped; a receiver that
 * cannot keep up loses audio and never a peer table; the newest socket for
 * a session wins; a session that ends takes its voice with it.
 */

const PEOPLE: Record<string, { name: string; userId: string }> = {
  A: { name: 'Ann', userId: 'u-ann' },
  B: { name: 'Bob', userId: 'u-bob' },
  C: { name: 'Cy', userId: 'u-cy' },
};
const TOKENS: Record<string, { userId: string }> = {
  'tok-ann': { userId: 'u-ann' },
  'tok-bob': { userId: 'u-bob' },
  'tok-cy': { userId: 'u-cy' },
};

const presence: VoicePresence = {
  roomId: 'room-1',
  workspaceId: 'ws-1',
  // An agent has presence in the office but is not a human: null here is
  // the whole of the "agents have no voice" rule, seen from the relay.
  human: (sessionId) => PEOPLE[sessionId] ?? null,
};

interface Client {
  ws: WebSocket;
  messages: VoiceServerMessage[];
  frames: Buffer[];
  /** Everything received, in order, so "peers before frames" can be asserted. */
  order: string[];
  closed: Promise<number>;
  next(type: VoiceServerMessage['type']): Promise<VoiceServerMessage>;
  frame(): Promise<Buffer>;
}

let server: Server;
let relay: VoiceRelay;
let url = '';
let pressure = 0;

function connect(sessionId: string, token: string, workspaceId = 'ws-1', at = url): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(at + VOICE_PATH);
    const messages: VoiceServerMessage[] = [];
    const frames: Buffer[] = [];
    const order: string[] = [];
    const waiters: Array<() => void> = [];
    // A close that never comes is a failure, not a wait: a sabotaged door that
    // lets everyone in must fail this suite rather than hang it.
    const closed = new Promise<number>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('the socket was never closed')), 3_000);
      ws.on('close', (code) => {
        clearTimeout(timer);
        done(code);
      });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        frames.push(Buffer.from(data as Buffer));
        order.push('frame');
      } else {
        const message = JSON.parse(String(data)) as VoiceServerMessage;
        messages.push(message);
        order.push(message.type);
      }
      for (const waiter of waiters.splice(0)) waiter();
    });

    const waitFor = <T>(pick: () => T | undefined): Promise<T> =>
      new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('timed out waiting')), 3_000);
        const check = (): boolean => {
          const found = pick();
          if (found === undefined) return false;
          clearTimeout(timer);
          done(found);
          return true;
        };
        if (!check()) waiters.push(() => void check());
      });

    const taken = { messages: 0, frames: 0 };
    const client: Client = {
      ws,
      messages,
      frames,
      order,
      closed,
      next: (type) =>
        waitFor(() => {
          const index = messages.findIndex((m, i) => i >= taken.messages && m.type === type);
          if (index === -1) return undefined;
          taken.messages = index + 1;
          return messages[index];
        }),
      frame: () =>
        waitFor(() => {
          if (frames.length <= taken.frames) return undefined;
          taken.frames += 1;
          return frames[taken.frames - 1];
        }),
    };

    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token, sessionId, workspaceId }));
      resolve(client);
    });
  });
}

function frameWith(seq: number, level = -30, payload = 'opus'): Buffer {
  const frame = Buffer.alloc(VOICE_HEADER_BYTES + payload.length);
  packVoiceHeader(frame, { seq, timestamp: seq * 960, level, flags: 0 });
  frame.write(payload, VOICE_HEADER_BYTES);
  return frame;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 120));

/** The joined list of a peers message, for a caller that asked for one. */
function joinedOf(message: VoiceServerMessage): Array<{ sessionId: string; name: string }> {
  return message.type === 'peers' ? message.joined : [];
}

/** A relay on its own port, for a suite that needs its own knobs. */
async function standUp(
  extra: Partial<ConstructorParameters<typeof VoiceRelay>[0]> = {},
): Promise<{ relay: VoiceRelay; server: Server; url: string }> {
  const instance = new VoiceRelay({
    verifyToken: async (token) => TOKENS[String(token)] ?? null,
    backpressure: () => pressure,
    audioHighWater: 100,
    heartbeatMs: 60_000,
    ...extra,
  });
  instance.registerRoom(presence);
  const http = createServer();
  http.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] === VOICE_PATH) instance.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { relay: instance, server: http, url: `ws://127.0.0.1:${address.port}` };
}

before(async () => {
  ({ relay, server, url } = await standUp());
});

after(async () => {
  relay.close();
  await new Promise<void>((done) => server.close(() => done()));
});

describe('the door', () => {
  it('refuses a socket that does not say hello', async () => {
    const ws = new WebSocket(url + VOICE_PATH);
    const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)));
    ws.on('open', () => ws.send(Buffer.from([1, 2, 3])));
    assert.equal(await closed, VOICE_CLOSE.BAD_HANDSHAKE);
  });

  it('refuses a token it cannot verify, and a valid token for somebody else’s seat', async () => {
    assert.equal(await (await connect('A', 'tok-nope')).closed, VOICE_CLOSE.UNAUTHORISED);
    assert.equal(await (await connect('A', 'tok-bob')).closed, VOICE_CLOSE.UNAUTHORISED);
  });

  it('refuses a session that is not a human in that office — an agent, a stranger, another office', async () => {
    assert.equal(await (await connect('bot', 'tok-ann')).closed, VOICE_CLOSE.NO_PRESENCE);
    assert.equal(await (await connect('Z', 'tok-ann')).closed, VOICE_CLOSE.NO_PRESENCE);
    assert.equal(await (await connect('A', 'tok-ann', 'ws-other')).closed, VOICE_CLOSE.NO_PRESENCE);
  });

  it('welcomes a person into their own seat', async () => {
    const a = await connect('A', 'tok-ann');
    assert.deepEqual(await a.next('welcome'), { type: 'welcome', sessionId: 'A' });
    a.ws.close();
    await a.closed;
  });
});

describe('who gets a frame', () => {
  it('reaches everyone in earshot, with their own index for the sender, and nobody else', async () => {
    const a = await connect('A', 'tok-ann');
    const b = await connect('B', 'tok-bob');
    const c = await connect('C', 'tok-cy');
    await Promise.all([a.next('welcome'), b.next('welcome'), c.next('welcome')]);

    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    const peers = await b.next('peers');
    assert.deepEqual(peers, {
      type: 'peers',
      joined: [{ sessionId: 'A', peerIndex: 0, name: 'Ann' }],
      left: [],
    });

    const sent = frameWith(1);
    a.ws.send(sent, { binary: true });
    const got = await b.frame();
    assert.equal(got[0], 0, 'the receiver’s index for Ann');
    assert.deepEqual(got.subarray(1), sent, 'and the frame exactly as sent');

    await settle();
    assert.equal(c.frames.length, 0, 'out of earshot hears nothing');
    assert.equal(a.frames.length, 0, 'and nobody hears themselves');

    // C walks in: the peers message lands before any frame from A.
    relay.updatePeers('room-1', [{ a: 'A', b: 'C', kind: 'enter' }]);
    await c.next('peers');
    a.ws.send(frameWith(2), { binary: true });
    await c.frame();
    assert.deepEqual(c.order.slice(0, 3), ['welcome', 'peers', 'frame']);

    // And out again: the frame stops, the table says so.
    relay.updatePeers('room-1', [{ a: 'A', b: 'C', kind: 'leave' }]);
    assert.deepEqual(await c.next('peers'), { type: 'peers', joined: [], left: ['A'] });
    a.ws.send(frameWith(3), { binary: true });
    await b.frame();
    await settle();
    assert.equal(c.frames.length, 1);

    for (const client of [a, b, c]) client.ws.close();
    await Promise.all([a.closed, b.closed, c.closed]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'leave' }]);
  });

  it('forwards a strange header as it came — the audio is not the relay’s to lose', async () => {
    const a = await connect('A', 'tok-ann');
    const b = await connect('B', 'tok-bob');
    await Promise.all([a.next('welcome'), b.next('welcome')]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    await b.next('peers');

    const odd = frameWith(9);
    odd.writeInt8(127, 6); // a level no client should produce
    a.ws.send(odd, { binary: true });
    const got = await b.frame();
    assert.equal(got.readInt8(7), 127, 'byte for byte, not rewritten');
    assert.equal(parseVoiceHeader(got.subarray(1))?.level, 0, 'and the reader clamps it');

    // Not a frame at all: refused, silently.
    a.ws.send(Buffer.alloc(3), { binary: true });
    await settle();
    assert.equal(b.frames.length, 1);

    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'leave' }]);
  });

  it('drops audio for a receiver that cannot keep up, and never its peer table', async () => {
    const a = await connect('A', 'tok-ann');
    const b = await connect('B', 'tok-bob');
    const c = await connect('C', 'tok-cy');
    await Promise.all([a.next('welcome'), b.next('welcome'), c.next('welcome')]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    await b.next('peers');

    pressure = 1_000_000;
    for (let seq = 0; seq < 5; seq += 1) a.ws.send(frameWith(seq), { binary: true });
    await settle();
    assert.equal(b.frames.length, 0, 'behind: audio is dropped');
    assert.equal(relay.dropped('B'), 5);

    relay.updatePeers('room-1', [{ a: 'B', b: 'C', kind: 'enter' }]);
    assert.deepEqual(
      joinedOf(await b.next('peers')).map((p) => p.sessionId),
      ['C'],
      'control still arrives',
    );

    pressure = 0;
    a.ws.send(frameWith(6), { binary: true });
    await b.frame();

    for (const client of [a, b, c]) client.ws.close();
    await Promise.all([a.closed, b.closed, c.closed]);
    relay.updatePeers('room-1', [
      { a: 'A', b: 'B', kind: 'leave' },
      { a: 'B', b: 'C', kind: 'leave' },
    ]);
  });
});

describe('sessions', () => {
  it('lets a newer socket for the same seat take over', async () => {
    const first = await connect('A', 'tok-ann');
    await first.next('welcome');
    const second = await connect('A', 'tok-ann');
    await second.next('welcome');
    assert.equal(await first.closed, VOICE_CLOSE.REPLACED);

    const b = await connect('B', 'tok-bob');
    await b.next('welcome');
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    await Promise.all([b.next('peers'), second.next('peers')]);
    b.ws.send(frameWith(1), { binary: true });
    await second.frame();

    second.ws.close();
    b.ws.close();
    await Promise.all([second.closed, b.closed]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'leave' }]);
  });

  it('tells a late arrival who is already in earshot, before any frame', async () => {
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    const a = await connect('A', 'tok-ann');
    await a.next('welcome');
    const b = await connect('B', 'tok-bob');
    await b.next('welcome');
    assert.deepEqual(
      joinedOf(await b.next('peers')).map((p) => p.name),
      ['Ann'],
    );
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'leave' }]);
  });

  it('a session that ends takes its voice with it, and leaves everybody’s table', async () => {
    const a = await connect('A', 'tok-ann');
    const b = await connect('B', 'tok-bob');
    await Promise.all([a.next('welcome'), b.next('welcome')]);
    relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
    await b.next('peers');

    relay.sessionLeft('room-1', 'A');
    assert.equal(await a.closed, VOICE_CLOSE.GONE);
    assert.deepEqual(await b.next('peers'), { type: 'peers', joined: [], left: ['A'] });
    b.ws.close();
    await b.closed;
  });
});

describe('an office with more than one room live', () => {
  it('finds the room that holds the seat, and losing one room does not lose the other', async () => {
    // A second map in the same workspace. Registered after the first, so a
    // "last one wins" lookup would send the first floor's people to 4404.
    relay.registerRoom({
      roomId: 'room-2',
      workspaceId: 'ws-1',
      human: (sessionId) => (sessionId === 'D' ? { name: 'Dee', userId: 'u-ann' } : null),
    });

    const a = await connect('A', 'tok-ann');
    assert.deepEqual(await a.next('welcome'), { type: 'welcome', sessionId: 'A' });
    const d = await connect('D', 'tok-ann');
    assert.deepEqual(await d.next('welcome'), { type: 'welcome', sessionId: 'D' });

    relay.unregisterRoom('room-2');
    assert.equal(await d.closed, VOICE_CLOSE.GONE, 'the second floor closed');
    // The first floor is untouched: a fresh socket for it still gets in.
    const again = await connect('B', 'tok-bob');
    assert.deepEqual(await again.next('welcome'), { type: 'welcome', sessionId: 'B' });

    a.ws.close();
    again.ws.close();
    await Promise.all([a.closed, again.closed]);
  });
});

describe('limits', () => {
  it('drops the newest speaker for an ear that already has too many', async () => {
    const own = await standUp({ speakersCap: 1 });
    try {
      const a = await connect('A', 'tok-ann', 'ws-1', own.url);
      const b = await connect('B', 'tok-bob', 'ws-1', own.url);
      const c = await connect('C', 'tok-cy', 'ws-1', own.url);
      await Promise.all([a.next('welcome'), b.next('welcome'), c.next('welcome')]);
      own.relay.updatePeers('room-1', [
        { a: 'A', b: 'C', kind: 'enter' },
        { a: 'B', b: 'C', kind: 'enter' },
      ]);
      await c.next('peers');

      a.ws.send(frameWith(1), { binary: true });
      await c.frame();
      b.ws.send(frameWith(1), { binary: true });
      await settle();
      assert.equal(c.frames.length, 1, 'a second mouth into a full ear is dropped');
      a.ws.send(frameWith(2), { binary: true });
      await c.frame();
      for (const client of [a, b, c]) client.ws.close();
      await Promise.all([a.closed, b.closed, c.closed]);
    } finally {
      own.relay.close();
      await new Promise<void>((done) => own.server.close(() => done()));
    }
  });

  it('lets one mouth send at the cadence of speech and no faster', async () => {
    // No refill at all: exactly the burst gets through, the rest is dropped
    // at the sender — the receiver never sees it, and never pays for it.
    const own = await standUp({ framesPerSecond: 0, burst: 10 });
    try {
      const a = await connect('A', 'tok-ann', 'ws-1', own.url);
      const b = await connect('B', 'tok-bob', 'ws-1', own.url);
      await Promise.all([a.next('welcome'), b.next('welcome')]);
      own.relay.updatePeers('room-1', [{ a: 'A', b: 'B', kind: 'enter' }]);
      await b.next('peers');

      for (let seq = 0; seq < 40; seq += 1) a.ws.send(frameWith(seq), { binary: true });
      await settle();
      await settle();
      assert.equal(b.frames.length, 10, 'the burst, and not one more');
      assert.equal(own.relay.throttled('A'), 30);
      assert.equal(own.relay.dropped('B'), 0, 'the receiver was never the problem');

      a.ws.close();
      b.ws.close();
      await Promise.all([a.closed, b.closed]);
    } finally {
      own.relay.close();
      await new Promise<void>((done) => own.server.close(() => done()));
    }
  });
});
