import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { Pool } from '../src/runner/pool.js';
import { Worker, type Turn } from '../src/runner/worker.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * `!reload` and `reload_tools` — a tool added after the session started.
 *
 * The case that asked for it: an owner ran `claude mcp add slack` while
 * talking to an agent, signed in, came back, and the agent still could not
 * see Slack — its runtime read its MCP configuration when the process
 * started. The only way out was a conversation that does not know what was
 * just said. A reload must restart the process, and keep the conversation:
 * the same ACP session, resumed, not a fresh one.
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
  scopes: ['chat', 'status'],
  limits: { walkUpRadiusTiles: 4 },
};

function fakeGateway(handlers: Handlers) {
  const said: string[] = [];
  const gateway = {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
    leave: async () => {},
    say: (text: string) => said.push(text),
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '' }),
    memorySet: async () => ({ ok: true }),
    channels: () => [],
    occupants: () => [],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
  return { gateway, said };
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

function fromOwner(text: string) {
  return { fromUserId: OWNER, fromName: 'Josh', fromKind: 'human' as const, text, distance: 1, sentAt: Date.now() };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Recorded {
  method: string;
  params?: { sessionId?: string; name?: string; result?: { ok?: boolean; result?: { reloading?: string } } };
}

function recorded(file: string): Recorded[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

const count = (file: string, method: string) => recorded(file).filter((entry) => entry.method === method).length;
const prompts = (file: string) => recorded(file).filter((entry) => entry.method === 'session/prompt');

describe('reloading an agent’s tools', () => {
  let current: AgentRunner | null = null;

  afterEach(async () => {
    const runner = current;
    current = null;
    await runner?.stop();
    for (const name of ['FAKE_RECORD', 'FAKE_RESUME', 'FAKE_TOOL_CALL', 'FAKE_REPLY']) delete process.env[name];
  });

  async function run(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'reload-'));
    const record = join(dir, 'record.jsonl');
    process.env.FAKE_RECORD = record;
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers);
    const runner = new AgentRunner(config(dir), undefined, fake.gateway);
    current = runner;
    await runner.start();
    return { handlers, record, ...fake };
  }

  it('restarts the runtime and resumes the same session on !reload', async () => {
    const { handlers, record, said } = await run({ FAKE_RESUME: '1' });

    handlers.chat?.(fromOwner('hello'));
    await until(() => prompts(record).length === 1 && said.includes('ok'), 'the first answer');
    const first = prompts(record)[0]?.params?.sessionId;
    assert.ok(first);

    handlers.chat?.(fromOwner('!reload'));
    await until(() => said.some((line) => line.startsWith('Tools reloaded')), 'the reload to be said');
    assert.equal(count(record, 'initialize'), 2, 'a reload is a new runtime process');
    assert.match(said.at(-1) ?? '', /carries on where it was/);

    handlers.chat?.(fromOwner('can you see slack now?'));
    await until(() => prompts(record).length === 2, 'the second prompt');
    assert.equal(prompts(record)[1]?.params?.sessionId, first, 'the conversation must carry on in the same session');
    assert.equal(count(record, 'session/resume'), 1);
    assert.equal(count(record, 'session/new'), 1, 'resuming is not opening a fresh session');
  });

  it('says the conversation starts afresh when the runtime cannot resume', async () => {
    const { handlers, record, said } = await run({});

    handlers.chat?.(fromOwner('hello'));
    await until(() => prompts(record).length === 1, 'the first prompt');

    handlers.chat?.(fromOwner('!reload'));
    await until(() => said.some((line) => line.startsWith('Tools reloaded')), 'the reload to be said');
    assert.match(said.at(-1) ?? '', /starts a fresh one/);

    handlers.chat?.(fromOwner('again'));
    await until(() => prompts(record).length === 2, 'the second prompt');
    assert.equal(count(record, 'session/new'), 2, 'a runtime that cannot resume gets a fresh session');
    assert.equal(count(record, 'session/resume'), 0);
  });

  it('lets the model ask for it, and waits for its turn to end', async () => {
    const { handlers, record, said } = await run({
      FAKE_RESUME: '1',
      FAKE_TOOL_CALL: 'reload_tools',
      FAKE_REPLY: 'Reloading — ask me again in a moment.',
    });

    handlers.chat?.(fromOwner('reload your tools so you can use Slack'));
    await until(() => said.some((line) => line.startsWith('Tools reloaded')), 'the reload to be said');

    const tool = recorded(record).find((entry) => entry.method === '_test/tool_result');
    assert.equal(tool?.params?.result?.ok, true);
    assert.equal(tool?.params?.result?.result?.reloading, 'when this turn ends');
    // The reply that asked is posted before the reload says it is done:
    // the process was not killed under the turn.
    const reply = said.indexOf('Reloading — ask me again in a moment.');
    assert.ok(reply >= 0, 'the turn that asked must finish');
    assert.ok(reply < said.findIndex((line) => line.startsWith('Tools reloaded')));
    assert.equal(count(record, 'initialize'), 2);
  });
});

/**
 * What a reload leaves behind for each worker: the sessions it will resume.
 * Two things must follow from that — the pool sends a conversation back to
 * the worker that holds it, and `!rotate` forgets it there too.
 */
describe('sessions a reload saved', () => {
  const workers: Worker[] = [];

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    for (const name of ['FAKE_RECORD', 'FAKE_RESUME']) delete process.env[name];
  });

  function pool(dir: string): Pool {
    return new Pool(2, (index) => {
      const worker = new Worker({
        index,
        config: config(dir),
        gateway: {} as Gateway,
        hooks: {},
        onUpdate: () => {},
        onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) as never,
        onExit: () => {},
        log: () => {},
      });
      workers.push(worker);
      return worker;
    });
  }

  /** A conversation on each of two workers, spoken in, then reloaded. */
  async function twoReloaded() {
    const dir = mkdtempSync(join(tmpdir(), 'reload-pool-'));
    const record = join(dir, 'record.jsonl');
    process.env.FAKE_RECORD = record;
    process.env.FAKE_RESUME = '1';
    const agents = pool(dir);
    const first = agents.claim('channel-a')!;
    first.turn = {} as Turn;
    const second = agents.claim('channel-b')!;
    second.turn = {} as Turn;
    assert.notEqual(first, second);
    await Promise.all([first.ready(), second.ready()]);
    await first.sessionFor('channel-a');
    await second.sessionFor('channel-b');
    // Spoken in: only a session that was told something is worth resuming.
    first.unprimed.delete('channel-a');
    second.unprimed.delete('channel-b');
    first.turn = null;
    second.turn = null;
    await Promise.all([first.reload(), second.reload()]);
    return { agents, first, second, record };
  }

  it('sends a conversation back to the worker that can resume it', async () => {
    const { agents, first, second, record } = await twoReloaded();
    assert.equal(agents.claim('channel-b'), second, 'not to whichever worker is free first');
    assert.equal(agents.claim('channel-a'), first);
    assert.equal(agents.idle('channel-b'), second, 'pre-warming follows the same rule');
    await second.sessionFor('channel-b');
    assert.equal(count(record, 'session/resume'), 1);
    assert.equal(count(record, 'session/new'), 2, 'only the two from before the reload');
  });

  it('forgets a saved session when the owner rotates that conversation', async () => {
    const { second, record } = await twoReloaded();
    assert.equal(second.dropSession('channel-b', 'rotate'), true);
    assert.equal(second.hasSession('channel-b'), false);
    await second.sessionFor('channel-b');
    assert.equal(count(record, 'session/resume'), 0, '!rotate means start over, not resume');
    assert.equal(count(record, 'session/new'), 3);
  });
});
