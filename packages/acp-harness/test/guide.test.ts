import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';
import { guideFileName, guideTitle, writeGuide } from '../src/nest.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * `!guide` — `!remember` for procedures.
 *
 * A rule about how to do a kind of work is too long for core memory, which
 * every session pays for, and too important to leave to whether the model
 * writes it down. So the owner dictates it and the harness files it: into the
 * nest's `GUIDES/`, where every agent on the machine reads it before that
 * kind of work, with one line in this agent's memory saying it is there.
 */

describe('naming a guide', () => {
  it('turns what the owner typed into the workspace convention', () => {
    assert.equal(guideFileName('code-review'), 'CODE_REVIEW.md');
    assert.equal(guideFileName('Code Review'), 'CODE_REVIEW.md');
    assert.equal(guideFileName('release.md'), 'RELEASE.md');
    assert.equal(guideFileName('  deploy--to prod!  '), 'DEPLOY_TO_PROD.md');
  });

  it('refuses a name with nothing in it', () => {
    assert.equal(guideFileName(''), null);
    assert.equal(guideFileName('---'), null);
  });

  it('keeps a name to a sensible length', () => {
    const file = guideFileName('x'.repeat(200));
    assert.ok(file !== null && file.length <= 64 + 3);
  });

  it('titles a fresh guide from its file name', () => {
    assert.equal(guideTitle('CODE_REVIEW.md'), 'Code review');
    assert.equal(guideTitle('RELEASE.md'), 'Release');
  });
});

describe('writing a guide', () => {
  const scratch: string[] = [];
  after(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });
  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-guide-'));
    scratch.push(dir);
    return dir;
  }

  it('creates the file with front matter and a title', () => {
    const nest = root();
    const when = new Date('2026-09-10T12:00:00Z');
    const result = writeGuide(nest, 'code-review', 'Read the whole diff first.', when);

    assert.equal(result.created, true);
    assert.equal(result.file, 'CODE_REVIEW.md');
    const text = readFileSync(join(nest, 'GUIDES', 'CODE_REVIEW.md'), 'utf8');
    assert.match(text, /^---\ntitle: "Code review"\n/);
    assert.match(text, /created: 2026-09-10\n/);
    assert.match(text, /\n# Code review\n\nRead the whole diff first\.\n$/);
  });

  it('adds to a guide that exists rather than replacing it', () => {
    const nest = root();
    writeGuide(nest, 'code-review', 'Read the whole diff first.', new Date('2026-09-10T12:00:00Z'));
    const result = writeGuide(nest, 'Code Review', 'Run the full suite.', new Date('2026-09-11T12:00:00Z'));

    assert.equal(result.created, false);
    const text = readFileSync(join(nest, 'GUIDES', 'CODE_REVIEW.md'), 'utf8');
    assert.match(text, /Read the whole diff first\./, 'the original is still there');
    assert.match(text, /\n## Added 2026-09-11\n\nRun the full suite\.\n$/);
  });

  it('refuses an empty body and a nameless guide', () => {
    const nest = root();
    assert.throws(() => writeGuide(nest, 'x', '   '), /body/);
    assert.throws(() => writeGuide(nest, '!!!', 'text'), /name/);
    assert.equal(existsSync(join(nest, 'GUIDES')), false, 'nothing was made');
  });
});

// --- through the runner -----------------------------------------------------

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

function fakeGateway(handlers: Handlers, seed = '') {
  const writes: Array<{ slug: string; content: string }> = [];
  const said: string[] = [];
  let stored = seed;

  const gateway = {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
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
    memoryGet: async () => ({ content: stored }),
    memorySet: async (slug: string, content: string) => {
      writes.push({ slug, content });
      stored = content;
      return { ok: true };
    },
    occupants: () => [],
    channels: () => [],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;

  return { gateway, writes, said, current: () => stored };
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

describe('telling an agent how to do something from now on', () => {
  let current: AgentRunner | null = null;
  let nest = '';
  let previousNest: string | undefined;

  before(() => {
    // The guide goes into the nest, wherever the agent itself is standing.
    nest = mkdtempSync(join(tmpdir(), 'quintal-guide-nest-'));
    previousNest = process.env.QUINTAL_NEST_DIR;
    process.env.QUINTAL_NEST_DIR = nest;
  });

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
  }

  after(async () => {
    await stopCurrent();
    if (previousNest === undefined) delete process.env.QUINTAL_NEST_DIR;
    else process.env.QUINTAL_NEST_DIR = previousNest;
    rmSync(nest, { recursive: true, force: true });
  });

  async function run(seed = '') {
    await stopCurrent();
    rmSync(join(nest, 'GUIDES'), { recursive: true, force: true });
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers, seed);
    const runner = new AgentRunner(
      config(mkdtempSync(join(tmpdir(), 'guide-cwd-'))),
      undefined,
      fake.gateway,
    );
    const guides: string[] = [];
    runner.on('guide', (file) => guides.push(file));
    current = runner;
    await runner.start();
    return { handlers, guides, ...fake };
  }

  it('files the guide in the nest, points core memory at it, and says so', async () => {
    const { handlers, writes, said, guides } = await run();

    handlers.chat?.(fromOwner('!guide code-review Read the whole diff, then run the full suite.'));
    await until(() => said.length > 0, 'the agent to answer');

    const path = join(nest, 'GUIDES', 'CODE_REVIEW.md');
    assert.ok(existsSync(path), 'the guide exists');
    assert.match(readFileSync(path, 'utf8'), /Read the whole diff, then run the full suite\./);
    assert.deepEqual(guides, ['CODE_REVIEW.md'], 'the fleet is told, so the index can refresh');
    assert.equal(writes.length, 1);
    assert.match(writes[0]?.content ?? '', /GUIDES\/CODE_REVIEW\.md/, 'core memory points at it');
    assert.match(said[0] ?? '', /Wrote GUIDES\/CODE_REVIEW\.md/);
  });

  it('adds to an existing guide without a second pointer', async () => {
    const { handlers, writes, said } = await run('code-review: GUIDES/CODE_REVIEW.md in my workspace');

    handlers.chat?.(fromOwner('!guide code-review First rule.'));
    await until(() => said.length > 0, 'the first answer');
    handlers.chat?.(fromOwner('!guide code-review Second rule.'));
    await until(() => said.length > 1, 'the second answer');

    const text = readFileSync(join(nest, 'GUIDES', 'CODE_REVIEW.md'), 'utf8');
    assert.match(text, /First rule\./);
    assert.match(text, /## Added \d{4}-\d{2}-\d{2}\n\nSecond rule\./);
    assert.equal(writes.length, 0, 'the pointer was already there');
    assert.match(said[1] ?? '', /Added that to GUIDES\/CODE_REVIEW\.md/);
  });

  it('asks for a name and a body rather than writing an empty guide', async () => {
    const { handlers, said, writes } = await run();

    handlers.chat?.(fromOwner('!guide'));
    await until(() => said.length > 0, 'the usage line');
    handlers.chat?.(fromOwner('!guide code-review'));
    await until(() => said.length > 1, 'the usage line again');

    assert.equal(existsSync(join(nest, 'GUIDES', 'CODE_REVIEW.md')), false);
    assert.equal(writes.length, 0);
    assert.match(said[0] ?? '', /!guide <name> <what to do>/);
  });

  it('is owner-only, like every other command', async () => {
    const { handlers, said, writes } = await run();

    handlers.chat?.(fromOwner('!guide code-review Be terse.', 'somebody-else'));
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(existsSync(join(nest, 'GUIDES', 'CODE_REVIEW.md')), false);
    assert.equal(writes.length, 0);
    assert.equal(said.length, 0);
  });
});
