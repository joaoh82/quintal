import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The runtime's own "may I run this tool?" question.
 *
 * It used to be said aloud beside the agent no matter where the turn came
 * from, so an owner reading a channel never saw it, and the two-minute
 * silence that followed reached the model as "declined twice by the user".
 * The review it was asked for died on that. These pin the two ways out: the
 * `run` scope, which has the harness answer on the owner's behalf, and a
 * question that goes where the owner actually is.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
  channelChat?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
}

const OWNER = 'owner-1';
const ENGINEERING = { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' };

function fakeGateway(
  handlers: Handlers,
  said: Array<[string, string | undefined]>,
  scopes: string[],
): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: OWNER,
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes,
    channels: [ENGINEERING],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
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
    channels: () => [ENGINEERING],
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

let clock = Date.now();

function inChannel(text: string, fromUserId = OWNER) {
  clock += 1_000;
  return {
    channel: ENGINEERING,
    from: 's-1',
    fromUserId,
    fromName: fromUserId === OWNER ? 'Josh' : 'Sam',
    fromKind: 'human',
    text,
    sentAt: clock,
    mentioned: true,
  };
}

function walkUp(text: string, fromUserId = OWNER) {
  clock += 1_000;
  return {
    fromUserId,
    fromName: 'Josh',
    fromKind: 'human' as const,
    text,
    distance: 1,
    sentAt: clock,
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('the runtime asks before running a tool', () => {
  let current: AgentRunner | null = null;
  let previousPermission: string | undefined;

  before(() => {
    // The fake agent asks for "Bash" before every reply.
    previousPermission = process.env.FAKE_PERMISSION;
    process.env.FAKE_PERMISSION = 'Bash';
  });

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
  }

  after(async () => {
    await stopCurrent();
    if (previousPermission === undefined) delete process.env.FAKE_PERMISSION;
    else process.env.FAKE_PERMISSION = previousPermission;
  });

  async function run(scopes: string[]) {
    await stopCurrent();
    const handlers: Handlers = {};
    const said: Array<[string, string | undefined]> = [];
    const logDir = mkdtempSync(join(tmpdir(), 'perm-log-'));
    const runner = new AgentRunner(
      config(mkdtempSync(join(tmpdir(), 'perm-cwd-'))),
      logDir,
      fakeGateway(handlers, said, scopes),
    );
    current = runner;
    await runner.start();
    const decisions = () => {
      const path = join(logDir, 'Bob.jsonl');
      if (!existsSync(path)) return [] as Array<{ tool: string; decision: string }>;
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { kind: string; tool?: string; decision?: string })
        .filter((entry) => entry.kind === 'permission')
        .map((entry) => ({ tool: entry.tool ?? '', decision: entry.decision ?? '' }));
    };
    const asked = () => said.filter(([text]) => /may I run/.test(text));
    return { handlers, said, decisions, asked };
  }

  it('is answered by the harness when the agent has the run scope, and logged', async () => {
    const { handlers, decisions, asked, said } = await run(['chat', 'run']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => decisions().length > 0, 'the decision to be logged');

    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'allowed by the run scope' }]);
    assert.equal(asked().length, 0, 'nobody was asked');
    await until(() => said.some(([text]) => text === 'ok'), 'the turn to finish');
  });

  it('goes to the owner in the channel the turn came from, and takes yes from there', async () => {
    const { handlers, decisions, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');

    const [question, channelId] = asked()[0]!;
    assert.equal(channelId, ENGINEERING.id, 'asked in the channel, not aloud');
    assert.match(question, /^@Josh may I run Bash\?/, 'the owner is mentioned');
    assert.match(question, /@Bob yes/);
    assert.match(question, /@Bob always/);

    handlers.channelChat?.(inChannel('@Bob yes'));
    await until(() => decisions().length > 0, 'the answer to land');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'once' }]);
  });

  it('takes "always" as a standing approval', async () => {
    const { handlers, decisions, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');
    handlers.channelChat?.(inChannel('@Bob always'));
    await until(() => decisions().length > 0, 'the answer to land');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'always' }]);
  });

  it('asks aloud when the turn was a walk-up', async () => {
    const { handlers, asked } = await run(['chat']);

    handlers.chat?.(walkUp('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');
    assert.equal(asked()[0]![1], undefined, 'said aloud, where the owner is standing');

    handlers.chat?.(walkUp('@Bob no'));
  });

  it('only the owner may answer', async () => {
    const { handlers, decisions, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');

    handlers.channelChat?.(inChannel('@Bob yes', 'somebody-else'));
    await settle();
    assert.equal(decisions().length, 0, 'a stranger saying yes changes nothing');

    handlers.channelChat?.(inChannel('@Bob no'));
    await until(() => decisions().length > 0, 'the owner to answer');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'deny' }]);
  });
});
