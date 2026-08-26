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
 * What the first message to an agent costs.
 *
 * It used to cost two complete model turns and a subprocess spawn, all on the
 * message path: the session was created lazily, and the standing instructions
 * were sent as their own awaited `prompt()` before the person's message was
 * even looked at. Every later message skipped all of it, which is why the first
 * one felt broken and the rest felt fine.
 *
 * These tests pin the two halves of the fix separately, because they can
 * regress separately: the session exists before anybody speaks, and the first
 * turn is one prompt rather than two.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
}

const READY = {
  agentId: 'agent-1',
  name: 'Bob',
  ownerName: 'Josh',
  limits: { walkUpRadiusTiles: 4 },
};

/**
 * A gateway that answers instantly and remembers what it was told.
 *
 * The runner reaches the network only through this type, so replacing it is
 * what makes the runner testable without an office, a websocket, or a model.
 */
function fakeGateway(handlers: Handlers): Gateway {
  return {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
    leave: async () => {},
    say: () => {},
    setStatus: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: 'I am a helpful teammate.' }),
    memorySet: async () => ({ ok: true }),
    occupants: () => [],
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
  } as unknown as AgentConfig;
}

function requests(path: string): Array<{ method: string; params?: unknown }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params?: unknown });
}

const of = (path: string, method: string) =>
  requests(path).filter((entry) => entry.method === method);

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const promptText = (entry: { params?: unknown }): string => {
  const params = entry.params as { prompt?: Array<{ text?: string }> };
  return (params.prompt ?? []).map((part) => part.text ?? '').join('');
};

describe('warming an agent before anybody speaks to it', () => {
  /**
   * One runner at a time, stopped before the next starts.
   *
   * Leaving them running overlapped two agent processes while `FAKE_RECORD` was
   * reassigned between cases, so a previous agent could still write into the
   * current case's file and a test would see a session it had not caused. The
   * failure looked like a bug in the code under test and was a bug in the test.
   */
  let current: AgentRunner | null = null;

  async function stopCurrent() {
    const runner = current;
    current = null;
    if (runner) await runner.stop().catch(() => {});
  }

  after(async () => {
    delete process.env.FAKE_RECORD;
    await stopCurrent();
  });

  /**
   * `FAKE_RECORD` goes through `process.env` because `AgentConfig` carries no
   * environment of its own — the runner sets only the bridge variables and
   * `AgentProcess` merges `process.env` underneath them. Safe here because
   * node:test runs the cases in a file one at a time; it would not be if these
   * ran concurrently, which is the trap this codebase has hit before.
   */
  async function start() {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-prewarm-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;

    const handlers: Handlers = {};
    const runner = new AgentRunner(config(dir), undefined, fakeGateway(handlers));
    current = runner;
    await runner.start();
    return { runner, record, handlers };
  }

  it('creates the session on connect, before any message arrives', async () => {
    const { record } = await start();

    await until(() => of(record, 'session/new').length === 1, 'a warmed session');

    assert.equal(
      of(record, 'session/prompt').length,
      0,
      'warming must not spend a model turn — an agent nobody talks to costs nothing',
    );
  });

  it('spends one prompt on the first message, not two', async () => {
    const { record, handlers } = await start();
    await until(() => of(record, 'session/new').length === 1, 'a warmed session');

    handlers.chat?.({
      text: 'Bob, hello',
      fromUserId: 'user-1',
      fromName: 'Josh',
      sentAt: Date.now(),
      distance: 1,
    });

    await until(() => of(record, 'session/prompt').length > 0, 'the first turn');
    // Give a second prompt every chance to appear before declaring there isn't one.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const prompts = of(record, 'session/prompt');
    assert.equal(
      prompts.length,
      1,
      'the standing instructions must ride along, not buy their own round trip',
    );
    assert.equal(
      of(record, 'session/new').length,
      1,
      'and the warmed session is the one that gets used',
    );
  });

  /**
   * The race pre-warming makes likely.
   *
   * Warming is deliberately not awaited, so at the moment `start()` returns
   * there is a session being created and not yet recorded. A message arriving
   * in that window used to find nothing and create a second session — leaking
   * one on the agent side and starting an unprimed one on ours.
   *
   * No wait before speaking: that gap *is* the window, and waiting for the warm
   * to land would test the safe case instead of the dangerous one.
   */
  it('joins a warm already in flight instead of starting a second session', async () => {
    const { record, handlers } = await start();

    handlers.chat?.({
      text: 'Bob, hello',
      fromUserId: 'user-1',
      fromName: 'Josh',
      sentAt: Date.now(),
      distance: 1,
    });

    await until(() => of(record, 'session/prompt').length > 0, 'the first turn');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      of(record, 'session/new').length,
      1,
      'two callers finding no session must not both make one',
    );
  });

  it('carries the standing instructions on that first turn, and not the next', async () => {
    const { record, handlers } = await start();
    await until(() => of(record, 'session/new').length === 1, 'a warmed session');

    const say = (text: string) =>
      handlers.chat?.({
        text,
        fromUserId: 'user-1',
        fromName: 'Josh',
        sentAt: Date.now(),
        distance: 1,
      });

    say('Bob, hello');
    await until(() => of(record, 'session/prompt').length === 1, 'the first turn');
    const first = promptText(of(record, 'session/prompt')[0]!);
    assert.match(first, /Core memory/, 'the first turn primes the session');
    assert.match(first, /Bob/, 'and still carries the actual message');

    say('Bob, again');
    await until(() => of(record, 'session/prompt').length === 2, 'the second turn');
    const second = promptText(of(record, 'session/prompt')[1]!);
    assert.doesNotMatch(
      second,
      /Core memory/,
      'a primed session must not be told its identity again every turn',
    );
  });
});
