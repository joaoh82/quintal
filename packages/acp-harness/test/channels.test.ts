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
 * An agent in a channel.
 *
 * Three things have to be true, and each is the kind that fails silently:
 * a line that does not name the agent must not cost a model turn (the noise
 * rule); a line that does must reach the model with the channel named, so it
 * knows where it is; and the reply must go back to the channel, not into the
 * air around the agent — an answer nobody in the channel can read is an
 * answer to the wrong room.
 */

interface Handlers {
  channelChat?: (message: unknown) => void;
  chat?: (message: unknown) => void;
}

const ENGINEERING = { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' };
/** As the agent sees it: named after the other party. */
const DM_WITH_JOSH = { id: 'dm-1', kind: 'dm', name: 'Josh', slug: '' };

/** Every status the runner set, with where it said the work was. */
const statuses: Array<[string, string | undefined]> = [];

function fakeGateway(handlers: Handlers, said: Array<[string, string | undefined]>): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    channels: [ENGINEERING, DM_WITH_JOSH],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push([text, channelId]);
    },
    setStatus: (status: string, channelId?: string) => {
      statuses.push([status, channelId]);
    },
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '' }),
    memorySet: async () => ({ ok: true }),
    occupants: () => [],
    channels: () => [ENGINEERING, DM_WITH_JOSH],
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

function prompts(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params?: unknown })
    .filter((entry) => entry.method === 'session/prompt')
    .map((entry) => {
      const params = entry.params as { prompt?: Array<{ text?: string }> };
      return (params.prompt ?? []).map((part) => part.text ?? '').join('');
    });
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

let clock = Date.now();

/** Each line a second after the last: the window excludes lines by time. */
function line(text: string, mentioned: boolean, channel = ENGINEERING) {
  clock += 1_000;
  return {
    channel,
    from: 's-1',
    fromUserId: 'user-1',
    fromName: 'Josh',
    fromKind: 'human',
    text,
    sentAt: clock,
    mentioned,
  };
}

describe('an agent in a channel', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
  }

  after(stopCurrent);

  async function start(): Promise<{
    handlers: Handlers;
    record: string;
    said: Array<[string, string | undefined]>;
  }> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-channel-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;

    const handlers: Handlers = {};
    const said: Array<[string, string | undefined]> = [];
    const runner = new AgentRunner(config(dir), undefined, fakeGateway(handlers, said));
    current = runner;
    await runner.start();
    return { handlers, record, said };
  }

  it('stays quiet for a line that does not name it', async () => {
    const { handlers, record } = await start();

    handlers.channelChat?.(line('morning all', false));
    await settle();

    assert.equal(prompts(record).length, 0, 'no turn was paid for');
  });

  it('wakes for a mention, is told which channel it is in, and answers there', async () => {
    const { handlers, record, said } = await start();

    handlers.channelChat?.(line('morning all', false));
    handlers.channelChat?.(line('@Bob what do you think?', true));
    await until(() => prompts(record).length > 0, 'a turn');

    const text = prompts(record)[0] ?? '';
    assert.match(text, /#engineering/, 'the model is told where it is');
    assert.match(text, /posted to the channel/, 'and where its reply goes');
    assert.match(
      text,
      /Josh: morning all/,
      'the line it was not woken for is still in the window',
    );

    await until(() => said.length > 0, 'a reply');
    assert.equal(said[0]?.[1], ENGINEERING.id, 'the reply is posted to the channel, not spoken');

    // While it worked, it said *where*: the channel shows it thinking there.
    assert.ok(
      statuses.some(([status, where]) => status === 'thinking' && where === ENGINEERING.id),
      `thinking was attributed to the channel: ${JSON.stringify(statuses)}`,
    );
    assert.ok(
      statuses.some(([status, where]) => status === '' && where === undefined),
      'and going idle carries no place',
    );
  });

  it('treats a direct message as addressed, and answers only the sender', async () => {
    const { handlers, record, said } = await start();

    // No name in it. In a DM there is nobody else it could be for, and the
    // office says so with `mentioned`.
    handlers.channelChat?.(line('are you there?', true, DM_WITH_JOSH));
    await until(() => prompts(record).length > 0, 'a turn');

    const text = prompts(record)[0] ?? '';
    assert.match(text, /direct message with Josh/, 'the model is told this is private');
    assert.match(text, /Only the two of you read this/);
    assert.doesNotMatch(text, /#engineering/, 'a DM is not a channel turn');

    await until(() => said.length > 0, 'a reply');
    assert.equal(said[0]?.[1], DM_WITH_JOSH.id, 'the reply goes back into the DM');
  });

  it('answers a walk-up out loud, as before', async () => {
    const { handlers, said } = await start();

    handlers.chat?.({
      text: 'Bob, hello',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      sentAt: Date.now(),
      distance: 1,
    });

    await until(() => said.length > 0, 'a reply');
    assert.equal(said[0]?.[1], undefined, 'a spatial turn is answered aloud');
  });
});
