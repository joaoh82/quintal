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
 * What an agent is actually told about itself.
 *
 * Three authors write into one system prompt and they must stay
 * distinguishable: the owner's instructions, which the agent may not change;
 * core memory, which the agent wrote itself; and the base prompt underneath
 * both. Merging them would leave the model unable to tell a standing directive
 * from its own note, and able to overwrite the directive by writing a note.
 *
 * These assert on the text that reaches `session/prompt`, because that is the
 * only thing the model ever sees. Everything upstream of it — the column, the
 * ready payload — is machinery that can be right while the prompt is wrong.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
}

function readyWith(instructions: string) {
  return {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions,
    limits: { walkUpRadiusTiles: 4 },
  };
}

function fakeGateway(handlers: Handlers, instructions: string, core: string): Gateway {
  const ready = readyWith(instructions);
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
    memoryGet: async () => ({ content: core }),
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

describe('what reaches the model on the first turn', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
  }

  after(stopCurrent);

  async function firstPrompt(instructions: string, core: string): Promise<string> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-prompt-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;

    const handlers: Handlers = {};
    const runner = new AgentRunner(
      config(dir),
      undefined,
      fakeGateway(handlers, instructions, core),
    );
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
    await until(() => prompts(record).length > 0, 'the first turn');
    return prompts(record)[0] ?? '';
  }

  it("carries the owner's instructions", async () => {
    const text = await firstPrompt('Answer in Portuguese.', '');

    assert.match(text, /Answer in Portuguese\./);
    assert.match(text, /\[Your owner's instructions\]/);
  });

  it('keeps the owner and the agent apart, and puts the owner first', async () => {
    const text = await firstPrompt('Answer in Portuguese.', 'Josh prefers short replies.');

    assert.match(text, /\[Your owner's instructions\]/);
    assert.match(text, /\[Core memory — your own notes\]/);
    assert.ok(
      text.indexOf("[Your owner's instructions]") <
        text.indexOf('[Core memory — your own notes]'),
      'where the two conflict, the person accountable for the agent wins',
    );
  });

  it('omits a heading nobody wrote anything under', async () => {
    // An empty section is not free: it is a line of prompt paid for on every
    // priming turn, and it invites the model to invent something to fill it.
    const text = await firstPrompt('', '');

    assert.doesNotMatch(text, /\[Your owner's instructions\]/);
    assert.doesNotMatch(text, /\[Core memory/);
  });

  it('tells the agent when to write memory, not just that it can', async () => {
    // The tool existed from the start and was never used once. A list of tool
    // names is not an instruction to reach for one.
    const text = await firstPrompt('', '');

    assert.match(text, /memory_set/);
    assert.match(text, /does not persist/);
  });
});
