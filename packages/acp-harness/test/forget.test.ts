import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner, forgetLines } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * `!forget` — the other half of `!remember`, and `!memory` — seeing what is
 * there. An owner who told an agent to always finish with a joke needs a way
 * to stop it that does not involve finding a database, and needs to hear
 * that it worked.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
}

const OWNER = 'owner-1';
const READY = {
  agentId: 'agent-1',
  name: 'Bob',
  ownerUserId: OWNER,
  ownerName: 'Josh',
  instructions: '',
  description: '',
  limits: { walkUpRadiusTiles: 4 },
};

function fakeGateway(handlers: Handlers, seed = '') {
  const writes: Array<{ slug: string; content: string }> = [];
  const said: string[] = [];
  let stored = seed;
  const gateway = {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
    leave: async () => {},
    say: (text: string) => {
      said.push(text);
    },
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: stored }),
    memorySet: async (slug: string, content: string) => {
      writes.push({ slug, content });
      stored = content;
      return { ok: true };
    },
    occupants: () => [],
    channels: () => [],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
  return { gateway, writes, said, current: () => stored };
}

function config(cwd: string): AgentConfig {
  return {
    name: 'Bob',
    key: 'agent-key',
    harness: 'custom',
    command: [process.execPath, FAKE],
    cwd,
    rootedAtReposDir: false,
    url: 'http://localhost:0',
    mapId: 'hq',
    workspaceId: 'ws-1',
  } as unknown as AgentConfig;
}

function fromOwner(text: string, fromUserId = OWNER) {
  return { fromUserId, fromName: 'Josh', fromKind: 'human' as const, text, distance: 1, sentAt: Date.now() };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('which lines a phrase forgets', () => {
  it('drops every line containing the words, case and spacing aside, and keeps the rest', () => {
    const memory = 'be terse\nAlways finish with a joke.\nask @sam before deploying\nfinish   with a JOKE when tired';
    const { kept, dropped } = forgetLines(memory, 'finish with a joke');
    assert.deepEqual(dropped, ['Always finish with a joke.', 'finish   with a JOKE when tired']);
    assert.equal(kept, 'be terse\nask @sam before deploying');
  });

  it('drops nothing for words that are not there, or for no words', () => {
    assert.deepEqual(forgetLines('be terse', 'jokes'), { kept: 'be terse', dropped: [] });
    assert.deepEqual(forgetLines('be terse', '   '), { kept: 'be terse', dropped: [] });
  });
});

describe('telling an agent to forget something', () => {
  let current: AgentRunner | null = null;
  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
  }
  after(stopCurrent);

  async function run(seed = '') {
    await stopCurrent();
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers, seed);
    const runner = new AgentRunner(config(mkdtempSync(join(tmpdir(), 'forget-'))), undefined, fake.gateway);
    current = runner;
    await runner.start();
    return { handlers, ...fake };
  }

  it('removes the matching note, keeps the others, and says so', async () => {
    const { handlers, writes, said } = await run('be terse\nalways finish with a joke');

    handlers.chat?.(fromOwner('!forget finish with a joke'));
    await until(() => writes.length > 0, 'the memory to be rewritten');

    assert.equal(writes[0]?.slug, 'core');
    assert.equal(writes[0]?.content, 'be terse');
    await until(() => said.length > 0, 'the agent to confirm');
    assert.match(said[0] ?? '', /Forgotten: "always finish with a joke"/);
  });

  it('says when nothing matched, and writes nothing', async () => {
    const { handlers, writes, said } = await run('be terse');

    handlers.chat?.(fromOwner('!forget jokes'));
    await until(() => said.length > 0, 'the agent to answer');

    assert.equal(writes.length, 0);
    assert.match(said[0] ?? '', /Nothing in my core memory says "jokes"/);
  });

  it('asks what to forget rather than clearing everything', async () => {
    const { handlers, writes, said } = await run('something worth keeping');

    handlers.chat?.(fromOwner('!forget'));
    await until(() => said.length > 0, 'the agent to ask');

    assert.equal(writes.length, 0, 'a bare !forget must not empty core memory');
    assert.match(said[0] ?? '', /Forget what/);
  });

  it('is owner-only, like every other command', async () => {
    const { handlers, writes, said } = await run('be terse');

    handlers.chat?.(fromOwner('!forget be terse', 'somebody-else'));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(writes.length, 0);
    assert.equal(said.length, 0);
  });

  it('!memory says what is there', async () => {
    const { handlers, said } = await run('be terse\nask @sam before deploying');

    handlers.chat?.(fromOwner('!memory'));
    await until(() => said.length > 0, 'the agent to recall');

    assert.match(said[0] ?? '', /be terse/);
    assert.match(said[0] ?? '', /ask @sam before deploying/);
  });
});
