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
 * A moment with a colleague.
 *
 * The office offers it; the harness may take it. Four things have to hold,
 * and each is a way the feature would cost more than it should. The line is
 * said aloud, once, with any `@` taken out — a mention in a joke wakes
 * whoever it named. The session it was told in is thrown away, so the joke
 * is not the context the next real question is answered from. A moment that
 * has passed is not answered. And a moment offered while there is work in
 * flight is declined without a turn being paid for.
 */

interface Handlers {
  chat?: (message: unknown) => void;
  banter?: (event: unknown) => void;
}

type Said = Array<[string, string | undefined]>;

function fakeGateway(handlers: Handlers, said: Said): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes: ['chat'],
    channels: [],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'bay', label: 'the Agent Bay' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push([text, channelId]);
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
    channels: () => [],
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

function requests(path: string): Array<{ method: string; params?: unknown }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params?: unknown });
}

function prompts(path: string): string[] {
  return requests(path)
    .filter((entry) => entry.method === 'session/prompt')
    .map((entry) => {
      const params = entry.params as { prompt?: Array<{ text?: string }> };
      return (params.prompt ?? []).map((part) => part.text ?? '').join('');
    });
}

function sessionsOpened(path: string): number {
  return requests(path).filter((entry) => entry.method === 'session/new').length;
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

const MARVIN = { id: 'agent-2', name: 'Marvin' };

function invitation(line: string | null, expiresAt = Date.now() + 45_000) {
  return { partner: MARVIN, line, zoneId: 'bay', expiresAt };
}

describe('a moment with a colleague', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
    delete process.env.FAKE_REPLY;
    delete process.env.FAKE_DELAY_MS;
  }

  after(stopCurrent);

  /** The fake agent reads its script from the environment as it starts. */
  async function start(
    env: { reply?: string; delayMs?: number } = {},
  ): Promise<{ handlers: Handlers; record: string; said: Said }> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-banter-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    process.env.FAKE_REPLY = env.reply ?? 'Slow day, @Marvin — even the linter is bored.';
    if (env.delayMs !== undefined) process.env.FAKE_DELAY_MS = String(env.delayMs);

    const handlers: Handlers = {};
    const said: Said = [];
    current = new AgentRunner(config(dir), undefined, fakeGateway(handlers, said));
    await current.start();
    return { handlers, record, said };
  }

  it('says one line aloud, with the @ taken out, and throws the session away', async () => {
    const { handlers, record, said } = await start();
    await until(() => sessionsOpened(record) >= 1, 'the warmed session');
    const before = sessionsOpened(record);

    handlers.banter?.(invitation(null));
    await until(() => said.length > 0, 'a line');

    assert.deepEqual(said, [['Slow day, Marvin — even the linter is bored.', undefined]]);

    const [prompt] = prompts(record);
    assert.ok(prompt, 'a turn was paid for');
    assert.match(prompt, /\[Banter\]/, 'and it was the banter prompt, not a work turn');
    assert.match(prompt, /Marvin/, 'naming the colleague');
    assert.doesNotMatch(prompt, /\[Recent conversation/, 'with no window');
    // The short preamble, not the priming a work session gets.
    assert.match(prompt, /You are "Bob"/, 'it is told who it is');
    assert.doesNotMatch(prompt, /You are working in an office/, 'but not the office manual');
    assert.doesNotMatch(prompt, /Tools available now/, 'nor a tool list');
    assert.doesNotMatch(prompt, /Core memory/, 'nor its memory');

    // And no tools on the session: the warmed work session has the tool
    // server, the banter session does not.
    const sessions = requests(record)
      .filter((entry) => entry.method === 'session/new')
      .map((entry) => (entry.params as { mcpServers?: unknown[] }).mcpServers?.length ?? 0);
    assert.deepEqual(sessions, [1, 0], 'tools for work, none for a joke');

    // The second invitation opens another session: the first was not kept.
    await settle();
    const after1 = sessionsOpened(record);
    assert.equal(after1, before + 1, 'one session for one banter');

    handlers.banter?.(invitation('Speak for yourself; I am thriving.'));
    await until(() => said.length > 1, 'an answer');
    await settle();
    assert.equal(sessionsOpened(record), after1 + 1, 'and another for the next — the first was dropped');

    const second = prompts(record)[1] ?? '';
    assert.match(second, /Speak for yourself; I am thriving\./, 'the answer is told what was said');
    assert.match(second, /Answer Marvin/, 'and asked to answer, not to open');
  });

  it('lets a moment that has passed go by', async () => {
    const { handlers, record, said } = await start();

    handlers.banter?.(invitation(null, Date.now() - 1));
    await settle();

    assert.equal(said.length, 0, 'nothing said');
    assert.equal(prompts(record).filter((p) => /\[Banter\]/.test(p)).length, 0, 'no turn paid for');
  });

  it('declines while there is work in flight, without paying for a turn', async () => {
    const { handlers, record, said } = await start({ reply: 'Working on it.', delayMs: 1500 });

    handlers.chat?.({
      text: 'Bob, have a look at the failing test',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      sentAt: Date.now(),
      distance: 1,
    });
    await until(() => prompts(record).length > 0, 'the work turn to start');
    handlers.banter?.(invitation(null));

    await until(() => said.length > 0, 'the work reply');
    await settle();

    assert.equal(prompts(record).filter((p) => /\[Banter\]/.test(p)).length, 0, 'no banter turn');
    assert.deepEqual(said, [['Working on it.', undefined]], 'only the work was spoken');
  });
});
