import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { basePrompt } from '../src/runner/base-prompt.js';
import { TOOL_HINT } from '../src/runner/context.js';
import { BASE_PROMPT } from '../src/runner/base-prompt.text.js';
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
  channels?: (event: unknown) => void;
  mention?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
}

interface Team {
  id: string;
  name: string;
  description: string;
  instructions: string;
  members: string[];
}

function readyWith(instructions: string, teams: Team[]) {
  return {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions,
    channels: [],
    teams,
    limits: { walkUpRadiusTiles: 4 },
  };
}

function fakeGateway(
  handlers: Handlers,
  instructions: string,
  core: string,
  teams: Team[] = [],
): Gateway {
  const ready = readyWith(instructions, teams);
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

describe('the base prompt', () => {
  // The desktop app spawns a `bun build --compile` binary, and for a while
  // every agent it launched ran on the seven-line emergency prompt: the
  // markdown was read relative to `import.meta.url`, which inside the binary
  // points at a virtual filesystem the file was never copied into. These pin
  // the full prompt to both places it can come from.

  it('is the full prompt, not the emergency one', () => {
    assert.match(basePrompt(), /You are working in an office/);
  });

  it('is embedded as code, byte for byte, for the compiled sidecar', () => {
    const markdown = readFileSync(
      fileURLToPath(new URL('../base_prompt.md', import.meta.url)),
      'utf8',
    ).trim();

    assert.match(BASE_PROMPT, /You are working in an office/);
    assert.equal(BASE_PROMPT, markdown, 'base-prompt.text.ts is stale: rebuild');
  });
});

describe('what reaches the model on the first turn', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
  }

  after(stopCurrent);

  async function firstPrompt(
    instructions: string,
    core: string,
    teams: Team[] = [],
  ): Promise<string> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-prompt-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;

    const handlers: Handlers = {};
    const runner = new AgentRunner(
      config(dir),
      undefined,
      fakeGateway(handlers, instructions, core, teams),
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

  it('tells live sessions about a team change, and only a change', async () => {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-prompt-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    const handlers: Handlers = {};
    const runner = new AgentRunner(config(dir), undefined, fakeGateway(handlers, '', ''));
    current = runner;
    await runner.start();
    const say = (text: string) =>
      handlers.chat?.({
        text,
        fromUserId: 'user-1',
        fromName: 'Josh',
        fromKind: 'human',
        sentAt: Date.now(),
        distance: 1,
      });

    say('Bob, hello');
    await until(() => prompts(record).length >= 1, 'the first turn');
    assert.doesNotMatch(prompts(record)[0] ?? '', /\[Team /, 'on no team yet');

    // Settings → Teams put Bob on engineering; the office says so on the
    // channels event. The session is live, so it has to be told again.
    const engineering = {
      id: 't1',
      name: 'engineering',
      description: 'Reviews.',
      instructions: 'Claim work before starting.',
      members: ['Bob', 'Codex'],
    };
    handlers.channels?.({ channels: [], teams: [engineering] });
    say('Bob, again');
    await until(() => prompts(record).length >= 2, 'the second turn');
    const second = prompts(record)[1] ?? '';
    assert.match(second, /\[You\]/, 're-primed: the system prompt was sent again');
    assert.match(second, /\[Team engineering\]/);
    assert.match(second, /Claim work before starting\./);

    // The same teams again — a channel change, say — is not a reason to
    // pay for another priming turn.
    handlers.channels?.({ channels: [], teams: [engineering] });
    say('Bob, once more');
    await until(() => prompts(record).length >= 3, 'the third turn');
    assert.doesNotMatch(prompts(record)[2] ?? '', /\[You\]/, 'nothing changed: not re-primed');
  });

  it("carries the owner's instructions", async () => {
    const text = await firstPrompt('Answer in Portuguese.', '');

    assert.match(text, /Answer in Portuguese\./);
    assert.match(text, /\[Your owner's instructions\]/);
    // And the manners underneath them: the whole file, not the fallback.
    assert.match(text, /You are working in an office/);
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

  it('tells the agent which teams it is on, between who it is and where it works', async () => {
    const text = await firstPrompt('', '', [
      {
        id: 't1',
        name: 'engineering',
        description: 'Reviews.',
        instructions: 'Claim work before starting.',
        members: ['Bob', 'Codex'],
      },
    ]);

    assert.match(text, /\[Team engineering\]/);
    assert.match(text, /You are on the engineering team with Codex\. Reviews\./);
    assert.match(text, /Claim work before starting\./);
    // Heading lines, not first mentions: the base prompt talks about the
    // `[Workspace]` section by name long before the section itself.
    const you = text.search(/^\[You\]$/m);
    const team = text.search(/^\[Team engineering\]$/m);
    const workspace = text.search(/^\[Workspace\]$/m);
    assert.ok(you !== -1 && workspace !== -1, 'both neighbours are present');
    assert.ok(you < team && team < workspace, 'after [You], before [Workspace]');
  });

  it('says nothing about teams to an agent on none', async () => {
    const text = await firstPrompt('', '', []);

    assert.doesNotMatch(text, /\[Team /);
  });

  it('tells the agent when to write memory, not just that it can', async () => {
    // The tool existed from the start and was never used once. A list of tool
    // names is not an instruction to reach for one.
    const text = await firstPrompt('', '');

    assert.match(text, /memory_set/);
    assert.match(text, /does not persist/);
  });
});

/**
 * A model with a runtime's own messaging tools in reach used them to "pick
 * up" a review — OMP's `hub send` to a name the hub had never heard of — and
 * the owner saw nothing for twenty-five minutes. The words the prompt uses to
 * close that door are pinned here, in both places they are said.
 */
describe('the one way to reach a person', () => {
  it('is said in the base prompt', () => {
    assert.match(basePrompt(), /`say` is the only way a person hears you/);
    assert.match(basePrompt(), /None of them reach the office/);
  });

  it('is said again in the tool hint', () => {
    assert.match(TOOL_HINT, /say is the only way\s+to reach a person/);
    assert.match(TOOL_HINT, /does not reach the office/);
  });
});
