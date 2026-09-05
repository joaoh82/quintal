import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * Saying something before the turn is over.
 *
 * Asked in a channel to review a PR, Arthur reviewed it, and everything he
 * had to say waited for the turn to end — where it was cut to three bubbles
 * and the review itself never appeared. The `say` tool is the other way to
 * talk: a line now, into the conversation the turn is in. Two things have to
 * hold. It goes where the turn is — a channel turn's "on it" is posted to
 * the channel, not spoken to whoever stands nearby. And the reply that
 * follows it is paced behind it rather than refused by the office's rate
 * limit and lost.
 */

interface Handlers {
  channelChat?: (message: unknown) => void;
  chat?: (message: unknown) => void;
}

const ENGINEERING = { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' };

type Said = Array<[string, string | undefined, number]>;

function fakeGateway(handlers: Handlers, said: Said): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes: ['chat'],
    channels: [ENGINEERING],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push([text, channelId, Date.now()]);
    },
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '' }),
    memorySet: async () => ({ ok: true }),
    occupants: () => [],
    channels: () => [ENGINEERING],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
}

function config(cwd: string): AgentConfig {
  return {
    name: 'Bob',
    key: 'agent-key',
    hostToken: '',
    agentId: '',
    harness: 'custom',
    command: [process.execPath, FAKE],
    cwd,
    rootedAtReposDir: false,
    url: 'http://localhost:0',
    mapId: 'hq',
    workspaceId: 'ws-1',
  } as unknown as AgentConfig;
}

/** What the tool answered, as the fake agent recorded it. */
function toolResults(path: string): Array<{ ok: boolean; result?: unknown; error?: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params?: { result?: unknown } })
    .filter((entry) => entry.method === '_test/tool_result')
    .map((entry) => entry.params?.result as { ok: boolean; result?: unknown; error?: string });
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('saying something mid-turn', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
    delete process.env.FAKE_TOOL_CALL;
    delete process.env.FAKE_REPLY;
  }

  after(stopCurrent);

  async function start(): Promise<{ handlers: Handlers; record: string; said: Said }> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-say-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    process.env.FAKE_TOOL_CALL = 'say:{"text":"on it — reading the diff"}';
    process.env.FAKE_REPLY = 'Review posted: two findings, one blocking.';

    const handlers: Handlers = {};
    const said: Said = [];
    current = new AgentRunner(config(dir), undefined, fakeGateway(handlers, said));
    await current.start();
    return { handlers, record, said };
  }

  it('posts into the channel the turn is in, ahead of the reply, and paces the reply behind it', async () => {
    const { handlers, record, said } = await start();

    handlers.channelChat?.({
      channel: ENGINEERING,
      from: 's-1',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      text: '@Bob review #52 please',
      sentAt: Date.now(),
      mentioned: true,
    });
    await until(() => said.length >= 2, 'the say and the reply');

    assert.deepEqual(
      said.map(([text, channelId]) => [text, channelId]),
      [
        ['on it — reading the diff', ENGINEERING.id],
        ['Review posted: two findings, one blocking.', ENGINEERING.id],
      ],
      'both lines went to the channel, the say first',
    );

    const [first, second] = said;
    assert.ok(first && second);
    assert.ok(
      second[2] - first[2] >= 2_000,
      `the reply waited for the office's rate limit: ${second[2] - first[2]}ms apart`,
    );

    const [answer] = toolResults(record);
    assert.ok(answer?.ok, `the tool answered ok: ${JSON.stringify(answer)}`);
    assert.deepEqual(answer.result, { posted_to: '#engineering', parts: 1 });
  });

  it('speaks aloud when the turn is a spatial one', async () => {
    const { handlers, said } = await start();

    handlers.chat?.({
      from: 's-1',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      text: 'Bob, have a look at #52',
      sentAt: Date.now(),
      distance: 1,
    });
    await until(() => said.length >= 1, 'the say');

    assert.deepEqual(said[0]?.slice(0, 2), ['on it — reading the diff', undefined]);
  });
});
