/** Send 20 bounded snapshots to the isolated office seeded by smoke-activity.mts. */
import { readFileSync } from 'node:fs';
import { Client } from 'colyseus.js';
const seed = JSON.parse(readFileSync('/tmp/quin49-verification/seed.json', 'utf8'));
const room = await new Client('http://127.0.0.1:3049/colyseus').joinOrCreate('office', {
  mapId: 'hq',
  workspaceId: seed.workspaceId,
  agentKey: seed.a.key,
});
room.onMessage('*', () => {});
const turnId = 'latency-' + Date.now();
const startedAt = Date.now();
for (let i = 1; i <= 20; i++) {
  const now = Date.now();
  room.send('agent:activity', {
    version: 1,
    turnId,
    requestId: turnId,
    workerId: 'probe',
    sessionId: 'probe',
    sequence: i,
    channelId: seed.alpha.id,
    state: i === 20 ? 'completed' : 'writing',
    startedAt,
    updatedAt: now,
    items: [
      {
        id: 'text',
        kind: 'message',
        text: `latency:${now}:${i}\n` + 'Streamed public reply. '.repeat(i * 10),
        state: i === 20 ? 'success' : 'running',
        startedAt,
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 250));
}
await room.leave(true);
process.exit(0);
