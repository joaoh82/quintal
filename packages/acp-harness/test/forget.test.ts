import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner, forgetLines } from '../src/runner/AgentRunner.js';
import {
  buildForgetPrompt,
  editDistance,
  findForget,
  numbered,
  parseForgetAnswer,
  parseLineNumbers,
} from '../src/runner/forget.js';
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

describe('finding the note the owner means', () => {
  const MEMORY = 'be terse\nAlways finish every answer with a joke.\nask @sam before deploying';

  it('reads a number, or a few, and nothing that has a word in it', () => {
    assert.deepEqual(parseLineNumbers('2'), [2]);
    assert.deepEqual(parseLineNumbers('#2'), [2]);
    assert.deepEqual(parseLineNumbers('2, 3'), [2, 3]);
    assert.deepEqual(parseLineNumbers('2 and 3'), [2, 3]);
    assert.equal(parseLineNumbers('the 3 rules'), null);
    assert.equal(parseLineNumbers('0'), null);
  });

  it('numbers the notes the way !forget <number> will count them', () => {
    assert.equal(numbered('be terse\n\n  ask @sam  \n'), '1. be terse\n2. ask @sam');
  });

  it('counts a swapped pair as one slip', () => {
    assert.equal(editDistance('naswer', 'answer'), 1);
    assert.equal(editDistance('joke', 'jokes'), 1);
    assert.equal(editDistance('terse', 'deploy'), 5);
  });

  it('forgives a typo and a word the owner left out', () => {
    const found = findForget(MEMORY, 'naswer every answer with a joke');
    assert.equal(found.kind, 'forgiving');
    assert.deepEqual(found.kind === 'forgiving' && found.dropped, ['Always finish every answer with a joke.']);
    assert.equal(found.kind === 'forgiving' && found.kept, 'be terse\nask @sam before deploying');
  });

  it('still prefers the exact words when they are there', () => {
    assert.equal(findForget(MEMORY, 'finish every answer').kind, 'exact');
  });

  it('asks rather than guessing when two notes fit, or none does', () => {
    const two = 'finish with a joke on Fridays\nfinish with a joke when tired';
    assert.deepEqual(findForget(two, 'the joke rule'), { kind: 'ask' });
    assert.deepEqual(findForget(MEMORY, 'the thing about humour'), { kind: 'ask' });
    assert.deepEqual(findForget('', 'anything'), { kind: 'empty' });
  });

  it('shows the model the notes numbered and reads numbers back, none winning', () => {
    const prompt = buildForgetPrompt(MEMORY, 'the joke thing');
    assert.match(prompt, /They said: "the joke thing"/);
    assert.match(prompt, /2\. Always finish every answer with a joke\./);
    assert.deepEqual(parseForgetAnswer('2', 3), [2]);
    assert.deepEqual(parseForgetAnswer('I would say 2 and 3.', 3), [2, 3]);
    assert.deepEqual(parseForgetAnswer('7', 3), [], 'a number off the end names nothing');
    assert.deepEqual(parseForgetAnswer('None — though 2 mentions jokes', 3), []);
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

  it('finds the note through a typo and a missing word', async () => {
    const { handlers, writes, said } = await run('be terse\nAlways finish every answer with a joke.');

    handlers.chat?.(fromOwner('!forget naswer every answer with a joke'));
    await until(() => writes.length > 0, 'the memory to be rewritten');

    assert.equal(writes[0]?.content, 'be terse');
    await until(() => said.length > 0, 'the agent to confirm');
    assert.match(said[0] ?? '', /Forgotten: "Always finish every answer with a joke\."/);
  });

  it('numbers its notes on !memory, and takes one by number', async () => {
    const { handlers, writes, said } = await run('be terse\nask @sam before deploying');

    handlers.chat?.(fromOwner('!memory'));
    await until(() => said.length > 0, 'the agent to recite');
    // Aloud, a listing is one bubble; the numbers still count.
    assert.equal(said[0], 'What I carry: 1. be terse 2. ask @sam before deploying');

    handlers.chat?.(fromOwner('!forget 2'));
    await until(() => writes.length > 0, 'the memory to be rewritten');
    assert.equal(writes[0]?.content, 'be terse');
    await until(() => said.length > 1, 'the agent to confirm');
    assert.match(said[1] ?? '', /Forgotten: "ask @sam before deploying"/);
  });

  it('asks its model when the words fit two notes, and drops the one it picks', async () => {
    process.env.FAKE_REPLY = '2';
    try {
      const { handlers, writes, said } = await run('finish with a joke on Fridays\nfinish with a joke when tired');

      handlers.chat?.(fromOwner('!forget the joke rule'));
      await until(() => writes.length > 0, 'the model to pick and the memory to be rewritten');

      assert.equal(writes[0]?.content, 'finish with a joke on Fridays');
      await until(() => said.length > 0, 'the agent to confirm');
      assert.match(said[0] ?? '', /Forgotten: "finish with a joke when tired"/);
    } finally {
      delete process.env.FAKE_REPLY;
    }
  });

  it('lists its notes, numbered, when the model finds nothing — and writes nothing', async () => {
    process.env.FAKE_REPLY = 'none';
    try {
      const { handlers, writes, said } = await run('be terse\nask @sam before deploying');

      handlers.chat?.(fromOwner('!forget the thing about humour'));
      await until(() => said.length > 0, 'the agent to answer');

      assert.match(said[0] ?? '', /Nothing in my core memory says "the thing about humour"/);
      assert.match(said[0] ?? '', /1\. be terse 2\. ask @sam before deploying/);
      assert.match(said[0] ?? '', /`!forget <number>` takes one out/);
      assert.equal(writes.length, 0);
    } finally {
      delete process.env.FAKE_REPLY;
    }
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
