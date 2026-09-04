import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * `!remember` — telling an agent something and having it still be true tomorrow.
 *
 * The tool to do this existed from the start and was never once used: an owner
 * would say "always greet people in Portuguese", the model would agree, and the
 * promise lived in an ACP session that is thrown away on restart and on
 * rotation. The memory table was empty on a database a week into use.
 *
 * So this is the certain path, and what it must guarantee is narrow: the note
 * lands in core memory, it does not destroy what was already there, and it
 * reaches the model without waiting for a session to rotate.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
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

/** Records what was written, and lets a test seed what was already there. */
function fakeGateway(handlers: Handlers, seed = '') {
  const writes: Array<{ slug: string; content: string }> = [];
  let stored = seed;

  const gateway = {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
    leave: async () => {},
    say: () => {},
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
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;

  return { gateway, writes, current: () => stored };
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

function fromOwner(text: string, fromUserId = OWNER) {
  return {
    fromUserId,
    fromName: 'Josh',
    fromKind: 'human' as const,
    text,
    distance: 1,
    sentAt: Date.now(),
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('telling an agent to remember something', () => {
  /**
   * One runner at a time, stopped before the next starts.
   *
   * Each runner owns a real child process. Leaving them alive overlaps agents
   * across cases and, more immediately, keeps the test process from exiting —
   * which looks exactly like a hang rather than the leak it is.
   */
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
    const runner = new AgentRunner(
      config(mkdtempSync(join(tmpdir(), 'remember-'))),
      undefined,
      fake.gateway,
    );
    // Set before starting, so a start that fails still leaves something to stop.
    current = runner;
    await runner.start();
    return { handlers, ...fake };
  }

  it('writes the note to core memory', async () => {
    const { handlers, writes } = await run();

    handlers.chat?.(fromOwner('!remember always greet people in Portuguese'));
    await until(() => writes.length > 0, 'the note to be written');

    assert.equal(writes[0]?.slug, 'core');
    assert.equal(writes[0]?.content, 'always greet people in Portuguese');
  });

  /**
   * The one that would quietly lose work. `memory_set` takes the whole slug, so
   * writing the new note alone erases everything learned before it — the second
   * `!remember` would undo the first.
   */
  it('appends rather than replacing what is already remembered', async () => {
    const { handlers, writes } = await run('always greet people in Portuguese');

    handlers.chat?.(fromOwner('!remember the deploy needs Sam to approve'));
    await until(() => writes.length > 0, 'the note to be written');

    assert.equal(
      writes[0]?.content,
      'always greet people in Portuguese\nthe deploy needs Sam to approve',
    );
  });

  it('ignores a bare !remember rather than writing nothing over everything', async () => {
    const { handlers, writes } = await run('something worth keeping');

    handlers.chat?.(fromOwner('!remember'));
    handlers.chat?.(fromOwner('!remember    '));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(writes.length, 0, 'an empty note must not clear core memory');
  });

  it('is owner-only, like every other command', async () => {
    const { handlers, writes } = await run();

    handlers.chat?.(fromOwner('!remember be terse', 'somebody-else'));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(writes.length, 0, 'only the accountable human may change what it carries');
  });

  it('keeps a name inside the note out of the addressing', async () => {
    // `!remember ask @sam before deploying` used to parse as a command aimed at
    // Sam, so an agent not called Sam dropped it without a word.
    const { handlers, writes } = await run();

    handlers.chat?.(fromOwner('!remember ask @sam before deploying'));
    await until(() => writes.length > 0, 'the note to be written');

    assert.equal(writes[0]?.content, 'ask @sam before deploying');
  });
});
