import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { AgentCommandCall } from '@quintal/shared';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { commandSection } from '../src/runner/context.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The office's own commands, as the agent receives them.
 *
 * `!review @engineering <link>` is a message with a brief on it. What has to
 * hold: it starts an ordinary turn whoever sent it — it is not an owner
 * command, and the agent's owner is not the only person who may ask for a
 * review — the brief and the argument reach the model, and a command the
 * office did not aim at this agent costs nothing.
 */

interface Handlers {
  channelChat?: (message: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
}

const ENGINEERING = { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' };

function fakeGateway(handlers: Handlers): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    channels: [ENGINEERING],
    teams: [],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: () => {},
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

const LINK = 'https://github.com/o/r/pull/155';

function review(addressed: boolean): AgentCommandCall {
  return {
    name: 'review',
    instructions: 'Read the whole diff. Say what would break, then what is merely untidy.',
    args: LINK,
    definedBy: 'Ana',
    addressed,
  };
}

/** Sent by somebody who is not Bob's owner: commands are not owner-only. */
const sender = { from: 's-1', fromUserId: 'user-2', fromName: 'Sam', fromKind: 'human' };

function inChannel(text: string, mentioned: boolean, command?: AgentCommandCall) {
  clock += 1_000;
  return { channel: ENGINEERING, ...sender, text, sentAt: clock, mentioned, command };
}

function nearby(text: string, distance: number, command?: AgentCommandCall) {
  clock += 1_000;
  return { ...sender, text, distance, sentAt: clock, command };
}

describe('an office command', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
  }

  after(stopCurrent);

  async function start(): Promise<{ handlers: Handlers; record: string }> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-command-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;

    const handlers: Handlers = {};
    const runner = new AgentRunner(config(dir), undefined, fakeGateway(handlers));
    current = runner;
    await runner.start();
    return { handlers, record };
  }

  it('starts a turn for anyone, with the brief and the argument in the prompt', async () => {
    const { handlers, record } = await start();

    handlers.channelChat?.(inChannel(`!review @engineering ${LINK}`, true, review(true)));
    await until(() => prompts(record).length > 0, 'a turn');

    const text = prompts(record)[0] ?? '';
    assert.match(text, /\[Command !review — set up in this office by Ana\]/);
    assert.match(text, /Read the whole diff/);
    assert.match(text, new RegExp(`What they gave it: ${LINK}`));
    assert.match(text, /Sam used !review/);
  });

  it('costs nothing in a channel when the office did not aim it here', async () => {
    const { handlers, record } = await start();

    // Aimed at somebody else: the office sends no command, and the line is
    // an unknown `!` verb from somebody who is not the owner.
    handlers.channelChat?.(inChannel(`!review @alice ${LINK}`, false));
    await settle();

    assert.equal(prompts(record).length, 0, 'no turn was paid for');
  });

  it('reaches an agent mentioned from across the office', async () => {
    const { handlers, record } = await start();

    clock += 1_000;
    handlers.mention?.({ ...sender, text: `!review ${LINK}`, sentAt: clock, command: review(true) });
    await until(() => prompts(record).length > 0, 'a turn');

    assert.match(prompts(record)[0] ?? '', /\[Command !review/);
  });

  it('aimed at nobody, is for an agent close enough to be walked up to, and no further', async () => {
    const { handlers, record } = await start();

    handlers.chat?.(nearby(`!review ${LINK}`, 12, review(false)));
    await settle();
    assert.equal(prompts(record).length, 0, 'across the room is not a walk-up');

    handlers.chat?.(nearby(`!review ${LINK}`, 2, review(false)));
    await until(() => prompts(record).length > 0, 'a turn');
    assert.match(prompts(record)[0] ?? '', /What they gave it/);
  });
});

describe('the command section of a prompt', () => {
  it('says when a command came with nothing after it, or no brief of its own', () => {
    const text = commandSection(
      { name: 'standup', instructions: '', args: '', definedBy: '', addressed: true },
      'Sam',
    );
    assert.equal(
      text,
      [
        '[Command !standup]',
        'Sam used !standup. It carries no instructions of its own; do what the line asks.',
        'They gave it nothing after the command.',
      ].join('\n'),
    );
  });
});
