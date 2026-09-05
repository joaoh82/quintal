import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { isHarnessNotice } from '../src/runner/outbound.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The runtime's housekeeping is not the agent's words.
 *
 * codex-acp renders Codex's own warnings as a message chunk ahead of the
 * reply. Arthur said "Warning: Skill descriptions were shortened to fit the
 * skills context budget…" out loud, in a channel, and in a DM, and then
 * explained to his owner that it was not him. The recogniser is narrow on
 * purpose: a whole "Warning: …" paragraph in one chunk is a shape a model's
 * token stream never produces.
 */

describe('recognising a runtime notice', () => {
  it('matches the shape codex-acp emits', () => {
    assert.equal(
      isHarnessNotice('Warning: Skill descriptions were shortened to fit the budget.\n\n'),
      true,
    );
    assert.equal(isHarnessNotice('Config warning: model not found\n\nfalling back\n\n'), true);
  });

  it('leaves a model saying "Warning:" alone', () => {
    // A model's text arrives as deltas, not a paragraph with its own blank line.
    assert.equal(isHarnessNotice('Warning: this'), false);
    assert.equal(isHarnessNotice('Warning'), false);
    assert.equal(isHarnessNotice('I have a warning: do not merge.\n\n'), false);
  });
});

interface Handlers {
  chat?: (message: unknown) => void;
}

function fakeGateway(handlers: Handlers, said: string[]): Gateway {
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
    say: (text: string) => {
      said.push(text);
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

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('what a runtime notice does to a reply', () => {
  let current: AgentRunner | null = null;

  after(async () => {
    await current?.stop();
    delete process.env.FAKE_WARNING;
    delete process.env.FAKE_REPLY;
  });

  it('is kept out of what the agent says, while the reply still gets through', async () => {
    process.env.FAKE_WARNING = 'Skill descriptions were shortened to fit the budget.';
    process.env.FAKE_REPLY = 'On it.';
    const dir = mkdtempSync(join(tmpdir(), 'quintal-notice-'));
    const handlers: Handlers = {};
    const said: string[] = [];
    current = new AgentRunner(config(dir), undefined, fakeGateway(handlers, said));
    await current.start();

    handlers.chat?.({
      text: 'Bob, hello',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      sentAt: Date.now(),
      distance: 1,
    });
    await until(() => said.length > 0, 'a reply');

    assert.deepEqual(said, ['On it.'], `only the model's words: ${JSON.stringify(said)}`);
  });
});
