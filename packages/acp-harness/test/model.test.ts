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
 * An agent runs on the model its owner chose, or does not run.
 *
 * Two things and their order. The model is set with
 * `session/set_config_option` after the session opens and before the first
 * prompt — a prompt that went out first would have been answered on the
 * default. And an agent asked for a model it was not offered refuses the
 * turn and says so in its status, rather than answering on whatever it
 * has: the quiet substitution is the failure nobody would see.
 */

interface Handlers {
  chat?: (message: unknown) => void;
}

function fakeGateway(handlers: Handlers, statuses: string[]): Gateway {
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
    setStatus: (status: string) => {
      statuses.push(status);
    },
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

function config(cwd: string, modelId?: string): AgentConfig {
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
    ...(modelId ? { modelId } : {}),
  } as unknown as AgentConfig;
}

function requests(path: string): Array<{ method: string; params?: Record<string, unknown> }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describe('running on the chosen model', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
    delete process.env.FAKE_MODELS;
  }

  after(stopCurrent);

  async function start(offered: string, wanted?: string) {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-model-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    process.env.FAKE_MODELS = offered;

    const handlers: Handlers = {};
    const statuses: string[] = [];
    const runner = new AgentRunner(config(dir, wanted), undefined, fakeGateway(handlers, statuses));
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
    return { record, statuses, handlers };
  }

  it('sets the model after the session opens and before the first prompt', async () => {
    const { record } = await start('sonnet,opus', 'opus');
    await until(() => requests(record).some((r) => r.method === 'session/prompt'), 'a turn');

    const methods = requests(record).map((r) => r.method);
    const set = methods.indexOf('session/set_config_option');
    assert.notEqual(set, -1, 'the model was set');
    assert.ok(set > methods.indexOf('session/new'), 'after the session existed');
    assert.ok(set < methods.indexOf('session/prompt'), 'before anything was asked');

    const call = requests(record).find((r) => r.method === 'session/set_config_option');
    assert.equal(call?.params?.['configId'], 'model');
    assert.equal(call?.params?.['value'], 'opus');
  });

  it('leaves the default alone when no model was chosen', async () => {
    const { record } = await start('sonnet,opus');
    await until(() => requests(record).some((r) => r.method === 'session/prompt'), 'a turn');
    assert.ok(!requests(record).some((r) => r.method === 'session/set_config_option'));
  });

  it('refuses to run on a model it was not offered, and keeps saying so', async () => {
    const { record, statuses, handlers } = await start('sonnet', 'opus');
    await settle();

    assert.ok(
      !requests(record).some((r) => r.method === 'session/prompt'),
      'no turn was paid for on the wrong model',
    );
    // Not merely said at some point: still on the nameplate after the turn
    // ended and the usual reset to idle ran. That reset is where the first
    // version lost it, and an idle agent that never answers explains nothing.
    assert.ok(
      (statuses.at(-1) ?? '').includes('opus'),
      `the status line still names the missing model: ${JSON.stringify(statuses)}`,
    );

    // A second message must not open a second session to be refused again.
    const sessions = requests(record).filter((r) => r.method === 'session/new').length;
    handlers.chat?.({
      text: 'Bob, still there?',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      sentAt: Date.now() + 1,
      distance: 1,
    });
    await settle();
    assert.equal(
      requests(record).filter((r) => r.method === 'session/new').length,
      sessions,
      'the refusal is remembered, not rediscovered per message',
    );
    assert.ok((statuses.at(-1) ?? '').includes('opus'), 'and the nameplate still says why');
  });
});
