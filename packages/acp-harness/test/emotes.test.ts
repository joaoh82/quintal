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
 * The balloons the harness puts up on its own.
 *
 * Nobody asks the model for these: a turn starting is the thinking balloon,
 * a tool running is the lightbulb, the turn ending takes it down. The table
 * that picks a balloon is tested in shared; this checks the runner actually
 * consults it at the moments that matter, and takes the balloon down again —
 * a thinking balloon left up on an idle agent is the lie this exists to avoid.
 */

interface Handlers {
  chat?: (message: unknown) => void;
}

function fakeGateway(handlers: Handlers, emotes: Array<[string, number | undefined]>): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    channels: [],
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
    emote: (emote: string, ttlMs?: number) => {
      emotes.push([emote, ttlMs]);
    },
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

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('balloons the harness puts up itself', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_TOOL;
  }

  after(stopCurrent);

  async function turn(tool?: string): Promise<Array<[string, number | undefined]>> {
    await stopCurrent();
    if (tool) process.env.FAKE_TOOL = tool;
    const dir = mkdtempSync(join(tmpdir(), 'quintal-emote-'));
    const handlers: Handlers = {};
    const emotes: Array<[string, number | undefined]> = [];
    const runner = new AgentRunner(config(dir), undefined, fakeGateway(handlers, emotes));
    current = runner;
    await runner.start();

    handlers.chat?.({
      text: 'Bob, hello',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      sentAt: Date.now(),
      distance: 1,
    });
    // The turn is over when the balloon has come down again.
    await until(() => emotes.some(([e]) => e === 'dots') && emotes.at(-1)?.[0] === '', 'a turn');
    return emotes;
  }

  it('thinks out loud, then takes the balloon down when the turn ends', async () => {
    const emotes = await turn();
    const ids = emotes.map(([e]) => e);
    assert.ok(ids.includes('dots'), `thinking was shown: ${JSON.stringify(ids)}`);
    assert.equal(ids.at(-1), '', 'and cleared afterwards');
    assert.ok(
      emotes.every(([, ttl]) => ttl === 0),
      'state balloons stay up until replaced, never on a timer',
    );
  });

  it('shows the lightbulb while a tool runs', async () => {
    const ids = (await turn('read_file')).map(([e]) => e);
    const think = ids.indexOf('dots');
    const work = ids.indexOf('idea');
    assert.notEqual(work, -1, `a tool put up the lightbulb: ${JSON.stringify(ids)}`);
    assert.ok(work > think, 'after thinking began');
    assert.equal(ids.at(-1), '', 'and everything came down at the end');
  });
});
