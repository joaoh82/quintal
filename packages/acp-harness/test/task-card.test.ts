import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { AgentTaskPayload } from '@quintal/shared';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';
import { activeTask } from '../src/runner/tasks.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The task on the agent's office card is whatever the harness last sent as
 * `agent:task`. It has to be sent at every moment the card would otherwise be
 * wrong: when a task begins, when its PR turns up or moves on, when it ends,
 * and when a harness comes back up with a task still in its book.
 */

interface Handlers {
  chat?: (message: unknown) => void;
}

const OWNER = 'owner-1';

function fakeGateway(handlers: Handlers, scopes = ['chat', 'status']) {
  const ready = {
    taskVersion: 1,
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: OWNER,
    ownerName: 'Josh',
    instructions: '',
    description: '',
    scopes,
    limits: { walkUpRadiusTiles: 4 },
  };
  const said: string[] = [];
  const tasks: AgentTaskPayload[] = [];
  const gateway = {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
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
    task: (value: AgentTaskPayload) => tasks.push(value),
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
  return { gateway, said, tasks };
}

function sh(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  }).trim();
}

/** A nest whose REPOS/ holds `api`, and a `gh` that answers from a file. */
function world(): { root: string; nest: string; ghSays: (pr: object | null) => void } {
  const root = mkdtempSync(join(tmpdir(), 'quintal-task-card-'));
  const nest = join(root, 'nest');
  const repos = join(root, 'repos');
  const bin = join(root, 'bin');
  mkdirSync(nest);
  mkdirSync(repos);
  mkdirSync(bin);
  const api = join(repos, 'api');
  sh(['init', '-q', '-b', 'main', api], root);
  writeFileSync(join(api, 'README.md'), 'x\n');
  sh(['add', '.'], api);
  sh(['commit', '-q', '-m', 'first'], api);
  symlinkSync(repos, join(nest, 'REPOS'));

  // `pullRequestFor` runs `gh pr view <branch> --json …`; this one prints
  // whatever the test last put in the file, or fails like "no pull requests".
  const answer = join(root, 'gh-answer.json');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\n[ -s "${answer}" ] || exit 1\ncat "${answer}"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const ghSays = (pr: object | null) => writeFileSync(answer, pr ? JSON.stringify(pr) : '');
  ghSays(null);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  return { root, nest, ghSays };
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

const BRANCH = 'quintal/bob/fix-the-login-redirect';
const URL_12 = 'https://github.com/acme/api/pull/12';

describe('the task on the office card', () => {
  const runners: AgentRunner[] = [];
  const roots: string[] = [];
  let previousNest: string | undefined;
  let previousPath: string | undefined;

  before(() => {
    previousNest = process.env.QUINTAL_NEST_DIR;
    previousPath = process.env.PATH;
  });
  after(async () => {
    await Promise.allSettled(runners.map((runner) => runner.stop()));
    if (previousNest === undefined) delete process.env.QUINTAL_NEST_DIR;
    else process.env.QUINTAL_NEST_DIR = previousNest;
    process.env.PATH = previousPath;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  async function run(scopes?: string[]) {
    const w = world();
    roots.push(w.root);
    process.env.QUINTAL_NEST_DIR = w.nest;
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers, scopes);
    const runner = new AgentRunner(config(w.nest), undefined, fake.gateway);
    runners.push(runner);
    await runner.start();
    return { runner, handlers, fake, ...w };
  }

  it('sends nothing at start when there is no task', async () => {
    const { fake } = await run();
    assert.deepEqual(fake.tasks, []);
  });

  it('sends the task when it begins, with no path in it', async () => {
    const { fake, handlers, nest } = await run();
    handlers.chat!(fromOwner('!task api: fix the login redirect'));
    await until(() => fake.tasks.length > 0, 'the task to reach the office');
    assert.deepEqual(fake.tasks, [{ title: 'fix the login redirect', repo: 'api', branch: BRANCH }]);
    assert.equal(activeTask(nest, 'Bob')?.branch, BRANCH);
  });

  it('sends the pull request when it is first seen and when it changes, and not otherwise', async () => {
    const { runner, fake, ghSays } = await run();
    await runner.beginTask('api', 'fix the login redirect');
    assert.equal(fake.tasks.length, 1);

    await runner.checkPullRequest();
    assert.equal(fake.tasks.length, 1, 'no PR yet: nothing new to say');

    ghSays({ number: 12, url: URL_12, state: 'OPEN', headRefOid: 'abc' });
    await runner.checkPullRequest();
    assert.deepEqual(fake.tasks.at(-1), {
      title: 'fix the login redirect',
      repo: 'api',
      branch: BRANCH,
      pr: { number: 12, url: URL_12, state: 'open' },
    });

    await runner.checkPullRequest();
    assert.equal(fake.tasks.length, 2, 'the same PR in the same state is not news');

    ghSays({ number: 12, url: URL_12, state: 'CLOSED', headRefOid: 'abc' });
    await runner.checkPullRequest();
    assert.equal(fake.tasks.length, 3);
    assert.equal((fake.tasks.at(-1) as { pr: { state: string } }).pr.state, 'closed');
  });

  it('shows the merge, then takes the card down as the merge ends the task', async () => {
    const { runner, fake, ghSays, nest } = await run();
    const task = await runner.beginTask('api', 'fix the login redirect');
    ghSays({ number: 12, url: URL_12, state: 'MERGED', headRefOid: sh(['rev-parse', 'HEAD'], task.worktree) });
    await runner.checkPullRequest();
    assert.equal(activeTask(nest, 'Bob'), null, 'a merged PR ends the task');
    assert.equal((fake.tasks.at(-2) as { pr: { state: string } }).pr.state, 'merged');
    assert.equal(fake.tasks.at(-1), null);
  });

  it('sends null when the task ends', async () => {
    const { fake, handlers } = await run();
    handlers.chat!(fromOwner('!task api: fix the login redirect'));
    await until(() => fake.tasks.length === 1, 'the task to begin');
    handlers.chat!(fromOwner('!done'));
    await until(() => fake.tasks.length === 2, 'the task to end');
    assert.equal(fake.tasks[1], null);
  });

  it('says the task again when a harness comes back up with one in its book', async () => {
    const first = await run();
    await first.runner.beginTask('api', 'fix the login redirect');
    first.ghSays({ number: 12, url: URL_12, state: 'OPEN', headRefOid: 'abc' });
    await first.runner.checkPullRequest();
    await first.runner.stop();

    // The same nest, a new process: what a restart is.
    const handlers: Handlers = {};
    const fake = fakeGateway(handlers);
    const again = new AgentRunner(config(first.nest), undefined, fake.gateway);
    runners.push(again);
    await again.start();
    assert.deepEqual(fake.tasks, [
      {
        title: 'fix the login redirect',
        repo: 'api',
        branch: BRANCH,
        pr: { number: 12, url: URL_12, state: 'open' },
      },
    ]);
  });

  it('sends nothing for an agent without the status scope, which would only be refused', async () => {
    const { runner, fake } = await run(['chat']);
    await runner.beginTask('api', 'fix the login redirect');
    await runner.endTask();
    assert.deepEqual(fake.tasks, []);
  });
});
