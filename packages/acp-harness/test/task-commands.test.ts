import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner, workspaceSection } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';
import { startBridge } from '../src/mcp/bridge.js';
import { activeTask } from '../src/runner/tasks.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * `!task` and `task_begin` are two doors into one room.
 *
 * The owner types one; the model calls the other before it edits a
 * repository. Both must land in the same book, move the agent's working
 * directory to the same worktree, and refuse a second task the same way —
 * and the `[Workspace]` section the model is given must say which it is on.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
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
  const statuses: string[] = [];
  const gateway = {
    ready: READY,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => READY,
    leave: async () => {},
    say: (text: string) => said.push(text),
    sayInChannel: (_id: string, text: string) => said.push(text),
    setStatus: (status: string) => statuses.push(status),
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
  return { gateway, said, statuses };
}

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  }).trim();
}

/** A nest whose REPOS/ links to a repos dir holding `api`, with no origin. */
function world(): { nest: string; repos: string } {
  const root = mkdtempSync(join(tmpdir(), 'quintal-task-cmd-'));
  const nest = join(root, 'nest');
  const repos = join(root, 'repos');
  mkdirSync(nest);
  mkdirSync(repos);
  const api = join(repos, 'api');
  sh(['init', '-q', '-b', 'main', api], root);
  writeFileSync(join(api, 'README.md'), 'x\n');
  sh(['add', '.'], api);
  sh(['commit', '-q', '-m', 'first'], api);
  symlinkSync(repos, join(nest, 'REPOS'));
  return { nest, repos };
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
  return { fromUserId, fromName: 'Josh', fromKind: 'human' as const, text, distance: 1, sentAt: Date.now() };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('a task from the owner and from the model', () => {
  let current: AgentRunner | null = null;
  let previousNest: string | undefined;
  const worlds: string[] = [];

  before(() => {
    previousNest = process.env.QUINTAL_NEST_DIR;
  });
  after(async () => {
    await current?.stop();
    if (previousNest === undefined) delete process.env.QUINTAL_NEST_DIR;
    else process.env.QUINTAL_NEST_DIR = previousNest;
    for (const root of worlds) rmSync(root, { recursive: true, force: true });
  });

  async function run() {
    await current?.stop();
    const { nest } = world();
    worlds.push(join(nest, '..'));
    // The runner keeps the book in the nest; point it at this test's.
    process.env.QUINTAL_NEST_DIR = nest;
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers);
    const runner = new AgentRunner(config(nest), undefined, fake.gateway);
    current = runner;
    await runner.start();
    return { runner, handlers, fake, nest };
  }

  it('`!task` moves the agent into a worktree, says so, and `!done` brings it back', async () => {
    const { runner, handlers, fake, nest } = await run();
    assert.equal(runner.cwd(), nest);

    handlers.chat!(fromOwner('!task api: fix the login redirect'));
    await until(() => activeTask(nest, 'Bob') !== null, 'the task to begin');

    const task = activeTask(nest, 'Bob')!;
    assert.equal(task.branch, 'quintal/bob/fix-the-login-redirect');
    assert.equal(runner.cwd(), task.worktree, 'sessions are rooted in the worktree now');
    assert.ok(existsSync(join(task.worktree, 'README.md')));
    await until(() => fake.said.some((line) => line.includes(task.branch)), 'the agent to name its branch');
    // Not on the nameplate: a non-empty status is the activity signal, and
    // an agent on a task for days must still read as idle and wander.
    assert.ok(!fake.statuses.some((status) => status.includes(task.branch)), 'the status line stays the activity signal');
    assert.match(workspaceSection(runner.cwd(), task), /You are on a task: "fix the login redirect"/);
    assert.equal((runner.workspaceInfo().task as { active: boolean }).active, true);

    handlers.chat!(fromOwner('!done'));
    await until(() => fake.said.some((line) => line.startsWith('Finished')), 'the agent to report the end');
    assert.equal(activeTask(nest, 'Bob'), null);
    assert.equal(runner.cwd(), nest);
    assert.ok(!existsSync(task.worktree), 'a clean, delivered worktree is removed');
  });

  it('two begins at once: one wins, the other is refused, and the book knows exactly one', async () => {
    const { runner, nest } = await run();
    const results = await Promise.allSettled([
      runner.beginTask('api', 'first in'),
      runner.beginTask('api', 'second in'),
      runner.beginTask('api', 'third in'),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1);
    assert.equal(lost.length, 2);
    for (const r of lost) assert.match(String((r as PromiseRejectedResult).reason.message), /already on a task/);
    const task = activeTask(nest, 'Bob')!;
    assert.ok(task);
    assert.equal(runner.cwd(), task.worktree);
    // Nothing orphaned: one worktree on disk, one in the book.
    const { readdirSync } = await import('node:fs');
    const onDisk = readdirSync(join(nest, 'WORKTREES', 'bob')).filter((name) => name !== 'tasks.json');
    assert.deepEqual(onDisk, [task.slug]);
  });

  it('refuses a second task, naming the first, and ignores a stranger', async () => {
    const { handlers, fake, nest } = await run();
    handlers.chat!(fromOwner('!task api: first'));
    await until(() => activeTask(nest, 'Bob') !== null, 'the first task');
    handlers.chat!(fromOwner('!task api: second'));
    await until(() => fake.said.some((line) => line.includes('already on a task')), 'the refusal');
    assert.ok(fake.said.find((line) => line.includes('already on a task'))!.includes('first'));

    handlers.chat!(fromOwner('!done', 'somebody-else'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.notEqual(activeTask(nest, 'Bob'), null, 'only the owner ends a task');
  });

  it('says how to use it when the command is malformed, and "not on a task" for a stray !done', async () => {
    const { handlers, fake, nest } = await run();
    handlers.chat!(fromOwner('!task api'));
    await until(() => fake.said.some((line) => line.includes('`!task <repo>: <what to do>`')), 'usage');
    handlers.chat!(fromOwner('!task nothing: x'));
    await until(() => fake.said.some((line) => line.includes('no REPOS/nothing')), 'the missing checkout named');
    assert.equal(activeTask(nest, 'Bob'), null);
    handlers.chat!(fromOwner('!done'));
    await until(() => fake.said.includes('I am not on a task.'), 'not on a task');
  });

  it('`task_begin` through the tool bridge lands in the same book', async () => {
    const { runner, fake, nest } = await run();
    // The hooks as the worker binds them: the runner's own begin, and its report.
    const bridge = await startBridge(fake.gateway, undefined, {
      taskBegin: (repo, title) => runner.beginTask(repo, title),
      taskEnd: () => runner.endTask(),
      taskStatus: () => runner.workspaceInfo().task,
    });
    try {
      const result = await call(bridge, 'task_begin', { repo: 'api', title: 'from the model' });
      assert.equal(result.ok, true);
      const task = activeTask(nest, 'Bob')!;
      assert.equal(task.title, 'from the model');
      assert.equal(runner.cwd(), task.worktree);
      assert.equal((result.result as { branch: string }).branch, task.branch);

      const status = await call(bridge, 'task_status', {});
      assert.equal((status.result as { branch: string }).branch, task.branch);

      const again = await call(bridge, 'task_begin', { repo: 'api', title: 'another' });
      assert.equal(again.ok, false);
      assert.match(again.error ?? '', /already on a task.*from the model/);

      const ended = await call(bridge, 'task_end', {});
      assert.equal(ended.ok, true);
      assert.equal(activeTask(nest, 'Bob'), null);
      assert.equal(runner.cwd(), nest);
    } finally {
      await bridge.close();
    }
  });
});

async function call(bridge: { url: string; token: string }, tool: string, args: Record<string, unknown>) {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quintal-token': bridge.token },
    body: JSON.stringify({ tool, args }),
  });
  return (await response.json()) as { ok: boolean; result?: unknown; error?: string };
}
