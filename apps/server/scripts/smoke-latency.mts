/** Correlation protocol smoke against a disposable office seeded by smoke-activity.mts. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client, type Room } from 'colyseus.js';

const [base, seedPath] = process.argv.slice(2);
assert.ok(base && seedPath, 'Usage: smoke-latency.mts LOCAL_URL PRIVATE_SEED');
const url = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port !== '3000');
const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as {
  workspaceId: string; token: string; a: { key: string }; alpha: { id: string };
};
const rooms: Room[] = [];
try {
  const connect = async (credentials: object) => {
    const room = await new Client(base + '/colyseus').joinOrCreate('office', {
      mapId: 'hq', workspaceId: seed.workspaceId, ...credentials,
    });
    room.onMessage('*', () => {});
    rooms.push(room);
    return room;
  };
  const human = await connect({ token: seed.token });
  const agent = await connect({ agentKey: seed.a.key });
  const received: Array<{ requestId?: string }> = [];
  agent.onMessage('agent:channel_chat', value => received.push(value));
  for (const input of [randomUUID().toUpperCase(), 'invalid-private-content', undefined]) {
    const before = received.length;
    human.send('channel_chat', { channelId: seed.alpha.id, text: '@Probe Alpha correlation smoke', requestId: input });
    const deadline = Date.now() + 5000;
    while (received.length === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(received.length, before + 1, 'human send reached the channel agent');
    assert.equal(received.at(-1)?.requestId, input?.includes('-private-') ? undefined : input?.toLowerCase());
  }
  console.log(JSON.stringify({ pass: true, forwarded: 3, validUuidPreserved: true, invalidDiscarded: true, legacySendAccepted: true }));
} finally {
  await Promise.allSettled(rooms.map(room => room.leave()));
}
