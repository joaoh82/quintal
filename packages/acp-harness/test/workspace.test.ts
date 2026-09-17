import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { AgentScope } from '@quintal/shared';

import type { Gateway } from '../src/gateway/client.js';
import { startBridge } from '../src/mcp/bridge.js';
import type { AgentConfig } from '../src/config.js';
import { AgentRunner, workspaceSection } from '../src/runner/AgentRunner.js';
import { TOOL_HINT } from '../src/runner/context.js';
import {
  redactRemote,
  urlOfOrigin,
  workspaceReport,
  type WorkspaceReport,
} from '../src/runner/workspace.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * "Where do you work, what can you see, and what are you allowed to do?"
 *
 * Asked any of those, an agent used to go looking: `pwd`, `ls`, `ls REPOS`,
 * `git remote -v`, half of them failing on directories that were never there.
 * `workspace_info` is the harness answering instead — one call, from the
 * process that already knows.
 *
 * Two things these tests are really defending. The answer must be *current*,
 * because a repository cloned an hour into a session is exactly the thing
 * somebody asks about; and it must never carry a credential out, because the
 * one field here that can hold one is a remote URL and a token-authenticated
 * clone leaves its token in `.git/config`.
 */

const IDENTITY = {
  agent: 'Bob',
  owner: 'Josh',
  runtime: 'claude-code',
  model: 'claude-opus-5',
  machine: 'joshs-laptop',
};

const ALL: AgentScope[] = ['chat', 'move', 'status', 'dm', 'run'];

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `quintal-${prefix}-`));
}

/** A directory that looks like a checkout, with the origin it was cloned from. */
function checkout(parent: string, name: string, origin?: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  if (origin !== undefined) {
    writeFileSync(
      join(dir, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`,
    );
  }
  return dir;
}

/** A nest: a workspace whose `REPOS/` is a link to where the owner keeps repositories. */
function nest(repos: string): string {
  const root = temp('nest');
  writeFileSync(join(root, 'AGENTS.md'), '# Your workspace\n');
  symlinkSync(repos, join(root, 'REPOS'), 'dir');
  return root;
}

function report(cwd: string, extra: { scopes?: AgentScope[]; reposDir?: string; limit?: number } = {}) {
  return workspaceReport({
    cwd,
    scopes: extra.scopes ?? ALL,
    identity: IDENTITY,
    ...(extra.reposDir === undefined ? {} : { reposDir: extra.reposDir }),
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
  });
}

describe('what the harness answers about this machine', () => {
  it('names the workspace, its AGENTS.md and the repositories linked into it', () => {
    const repos = temp('repos');
    checkout(repos, 'quintal', 'git@github.com:joaoh82/quintal.git');
    checkout(repos, 'flotta', 'https://github.com/joaoh82/flotta.git');
    mkdirSync(join(repos, 'scratchpad'));
    const root = nest(repos);

    const result = report(root);

    assert.equal(result.working_directory, root);
    assert.match(result.agents_md ?? '', /AGENTS\.md/);
    assert.equal(result.repositories.path, repos);
    assert.equal(result.repositories.reached_as, 'REPOS/');
    assert.deepEqual(result.repositories.checkouts, [
      { name: 'flotta', git: true, remote: 'github.com/joaoh82/flotta' },
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
      // Not a checkout, but it is there, and an agent told otherwise would
      // clone on top of it. After the repositories, because that is what was
      // asked about.
      { name: 'scratchpad', git: false },
    ]);
    assert.equal(result.repositories.more, undefined);
  });

  it('says nothing about an AGENTS.md that is not there', () => {
    const dir = temp('bare');
    assert.equal(report(dir).agents_md, undefined);
  });

  it('falls back to the repositories directory this machine reported, for a custom cwd', () => {
    const repos = temp('repos');
    checkout(repos, 'api', 'https://github.com/acme/api.git');
    // An agent rooted in one checkout: no nest, no REPOS/, but the machine
    // still has a repositories directory and saying so is the honest answer.
    const cwd = checkout(temp('single'), 'api-checkout', 'https://github.com/acme/api.git');

    const result = report(cwd, { reposDir: repos });
    assert.equal(result.working_directory_repo, 'github.com/acme/api');
    assert.equal(result.repositories.path, repos);
    assert.equal(result.repositories.reached_as, repos);
    assert.deepEqual(result.repositories.checkouts?.map((entry) => entry.name), ['api']);
  });

  it('says plainly when there is no repositories directory at all', () => {
    const cwd = checkout(temp('single'), 'api', 'https://github.com/acme/api.git');
    const result = report(cwd);
    assert.equal(result.repositories.path, null);
    assert.equal(result.repositories.note, 'no repositories directory on this machine');
    assert.equal(result.repositories.checkouts, undefined);
    // Rooted in one repository: which one is the first thing it will be asked.
    assert.equal(result.working_directory_repo, 'github.com/acme/api');
  });

  it('names a checkout it is standing in even when it cannot name the remote', () => {
    const cwd = checkout(temp('single'), 'local-only');
    assert.match(report(cwd).working_directory_repo ?? '', /no origin remote/);
    // The shared workspace is not a checkout, and should not be called one.
    assert.equal(report(nest(temp('repos'))).working_directory_repo, undefined);
  });

  it('reports an empty repositories directory as empty, not as missing', () => {
    const repos = temp('repos');
    const result = report(nest(repos));
    assert.equal(result.repositories.path, repos);
    assert.equal(result.repositories.note, 'nothing cloned here yet');
    assert.equal(result.repositories.checkouts, undefined);
  });

  it('reports a repositories directory that is not there, without inventing one', () => {
    const missing = join(temp('gone'), 'nowhere');
    const result = report(temp('bare'), { reposDir: missing });
    assert.equal(result.repositories.path, missing);
    assert.equal(result.repositories.note, 'this directory is not there');
  });

  it('reports a working directory that is not there', () => {
    const gone = join(temp('gone'), 'nowhere');
    const result = report(gone);
    assert.match(result.working_directory, /not on this machine/);
    assert.equal(result.agents_md, undefined);
  });

  it('bounds the listing and says how much it left out', () => {
    const repos = temp('repos');
    for (const name of ['a', 'b', 'c', 'd', 'e']) checkout(repos, name);
    const result = report(nest(repos), { limit: 2 });
    assert.deepEqual(result.repositories.checkouts?.map((entry) => entry.name), ['a', 'b']);
    assert.equal(result.repositories.more, 3);
    // Checkouts were cut, which is the case worth admitting to.
    assert.match(result.repositories.note ?? '', /3 more checkouts/);
  });

  it('never lets a plain folder push a repository off the list', () => {
    // The shape that made this necessary: a repositories directory that has
    // collected scratch folders, and the repositories named late in the
    // alphabet falling off the end of an alphabetical cut.
    const repos = temp('repos');
    for (const name of ['aaa-notes', 'bbb-downloads', 'ccc-tmp']) mkdirSync(join(repos, name));
    checkout(repos, 'zzz-api', 'https://github.com/acme/api.git');
    checkout(repos, 'yyy-web', 'https://github.com/acme/web.git');

    const result = report(nest(repos), { limit: 3 });
    assert.deepEqual(result.repositories.checkouts?.map((entry) => entry.name), [
      'yyy-web',
      'zzz-api',
      'aaa-notes',
    ]);
    assert.equal(result.repositories.more, 2);
    // Only folders were dropped, so there is nothing to warn about.
    assert.equal(result.repositories.note, undefined);
  });

  it('reads the inventory again on every call', () => {
    const repos = temp('repos');
    checkout(repos, 'quintal', 'https://github.com/joaoh82/quintal.git');
    const root = nest(repos);
    assert.deepEqual(report(root).repositories.checkouts?.map((entry) => entry.name), ['quintal']);

    // Cloned mid-session. The next answer has it; nothing was cached.
    checkout(repos, 'buzz', 'https://github.com/joaoh82/buzz.git');
    assert.deepEqual(report(root).repositories.checkouts?.map((entry) => entry.name), [
      'buzz',
      'quintal',
    ]);
  });

  it('opens a folder that groups repositories, one level and no further', () => {
    // `r_n_d/` holding five repositories is not a scratch folder, and an
    // inventory that cannot see inside it reports five repositories as none.
    const repos = temp('repos');
    checkout(repos, 'quintal', 'https://github.com/joaoh82/quintal.git');
    const group = join(repos, 'r_n_d');
    mkdirSync(group);
    checkout(group, 'parser', 'https://github.com/joaoh82/parser.git');
    checkout(group, 'sketches');
    // Two levels down is somebody's source tree. Not ours.
    mkdirSync(join(group, 'deeper', 'too-far', '.git'), { recursive: true });

    const result = report(nest(repos));
    assert.deepEqual(result.repositories.checkouts, [
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
      { name: 'r_n_d/parser', git: true, remote: 'github.com/joaoh82/parser' },
      { name: 'r_n_d/sketches', git: true },
    ]);
    // Only repositories come back from inside a folder. `r_n_d/deeper` is a
    // plain directory one level in, and listing every one of those would fill
    // the answer with the noise the descent was meant to see past.
    assert.ok(!result.repositories.checkouts?.some((entry) => entry.name.includes('deeper')));
    assert.ok(!result.repositories.checkouts?.some((entry) => entry.name.includes('too-far')));
  });

  it('does not open a checkout looking for more checkouts inside it', () => {
    const repos = temp('repos');
    const outer = checkout(repos, 'quintal', 'https://github.com/joaoh82/quintal.git');
    // A vendored tree inside a repository is that repository's business.
    mkdirSync(join(outer, 'vendor', 'thing', '.git'), { recursive: true });

    assert.deepEqual(report(nest(repos)).repositories.checkouts, [
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
    ]);
  });

  it('keeps a folder that turned out to hold nothing', () => {
    const repos = temp('repos');
    checkout(repos, 'api', 'https://github.com/acme/api.git');
    mkdirSync(join(repos, 'downloads', 'zips'), { recursive: true });

    assert.deepEqual(report(nest(repos)).repositories.checkouts, [
      { name: 'api', git: true, remote: 'github.com/acme/api' },
      { name: 'downloads', git: false },
    ]);
  });

  it('splits the scopes the office granted from the ones it did not', () => {
    const result = report(temp('bare'), { scopes: ['chat', 'dm'] });
    assert.deepEqual(Object.keys(result.quintal_scopes.granted), ['chat', 'dm']);
    assert.deepEqual(Object.keys(result.quintal_scopes.not_granted), ['move', 'status', 'run']);
    assert.match(result.quintal_scopes.granted.chat ?? '', /say/);
    assert.match(result.quintal_scopes.not_granted.move ?? '', /walk/);
    assert.match(result.quintal_scopes.unscoped, /memory_get/);
  });

  it('carries the runtime it is on, not a guess at one', () => {
    const result = report(temp('bare'));
    assert.deepEqual(result.runtime, { ...IDENTITY, platform: process.platform });
  });

  it('never claims access it has not verified', () => {
    const result = report(temp('bare'));
    assert.equal(result.external_access.verified, 'nothing');
    assert.match(result.external_access.note, /never contacts a remote/);
    assert.match(result.external_access.note, /unknown/);
  });
});

describe('what a remote is allowed to say', () => {
  it('drops the credentials a token-authenticated clone leaves behind', () => {
    const repos = temp('repos');
    checkout(repos, 'quintal', 'https://x-access-token:ghp_ATOKENTHATMUSTNOTLEAK@github.com/joaoh82/quintal.git');
    const result = report(nest(repos));

    assert.deepEqual(result.repositories.checkouts, [
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
    ]);
    const serialised = JSON.stringify(result);
    assert.ok(!serialised.includes('ghp_'), 'no token anywhere in the payload');
    assert.ok(!serialised.includes('x-access-token'), 'no user info anywhere in the payload');
  });

  it('reduces every remote it recognises to host and path', () => {
    assert.equal(redactRemote('git@github.com:joaoh82/quintal.git'), 'github.com/joaoh82/quintal');
    assert.equal(redactRemote('https://github.com/joaoh82/quintal'), 'github.com/joaoh82/quintal');
    assert.equal(redactRemote('ssh://git@github.com/joaoh82/quintal.git'), 'github.com/joaoh82/quintal');
    assert.equal(redactRemote('https://user:pass@gitlab.example.com:8443/team/svc.git'), 'gitlab.example.com/team/svc');
    assert.equal(redactRemote('git://git.kernel.org/pub/scm/git/git.git'), 'git.kernel.org/pub/scm/git/git');
  });

  it('says nothing at all about anything it does not recognise', () => {
    // A local path remote is a directory elsewhere on the owner's machine.
    assert.equal(redactRemote('/Users/josh/other/private-thing'), null);
    assert.equal(redactRemote('../sibling'), null);
    assert.equal(redactRemote('file:///Users/josh/private'), null);
    // A token smuggled as a query parameter.
    assert.equal(redactRemote('https://github.com/o/r.git?token=ghp_secret'), null);
    assert.equal(redactRemote(null), null);
    assert.equal(redactRemote(''), null);
    assert.equal(redactRemote(`https://github.com/${'x'.repeat(600)}`), null);
  });

  it('takes the origin url out of a real config and no other', () => {
    const config = [
      '[remote "upstream"]',
      '\turl = https://github.com/upstream/repo.git',
      '[remote "origin"]',
      '\turl = git@github.com:mine/repo.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');
    assert.equal(urlOfOrigin(config), 'git@github.com:mine/repo.git');
    assert.equal(urlOfOrigin('[core]\n\tbare = false\n'), null);
  });

  it('follows a worktree to the repository that owns it', () => {
    // Somebody who works in worktrees has several checkouts of one repository
    // side by side. Reporting each as a checkout of nothing in particular is
    // how an agent ends up unable to say what it is looking at.
    const repos = temp('repos');
    const owner = checkout(repos, 'quintal', 'git@github.com:joaoh82/quintal.git');
    const wt = join(repos, 'quintal-pin170');
    const gitdir = join(owner, '.git', 'worktrees', 'pin170');
    mkdirSync(wt, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);

    assert.deepEqual(report(nest(repos)).repositories.checkouts, [
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
      { name: 'quintal-pin170', git: true, remote: 'github.com/joaoh82/quintal' },
    ]);
  });

  it('follows a submodule to the config in its own gitdir', () => {
    const repos = temp('repos');
    const dir = join(repos, 'vendored');
    const gitdir = join(repos, '.store', 'modules', 'vendored');
    mkdirSync(dir, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'config'), '[remote "origin"]\n\turl = https://github.com/acme/lib.git\n');
    writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`);

    assert.deepEqual(report(nest(repos)).repositories.checkouts, [
      { name: 'vendored', git: true, remote: 'github.com/acme/lib' },
    ]);
  });

  it('says a checkout has no remote rather than inventing one', () => {
    const repos = temp('repos');
    const dir = join(repos, 'orphan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.git'), 'gitdir: /nowhere/that/exists/.git/worktrees/x\n');
    assert.deepEqual(report(nest(repos)).repositories.checkouts, [{ name: 'orphan', git: true }]);
  });
});

describe('how an agent finds out it can ask', () => {
  it('points the system prompt at the tool instead of at a shell', () => {
    const section = workspaceSection(temp('bare'));
    assert.match(section, /workspace_info/);
    assert.match(section, /do not go looking with pwd, ls or git remote/);
  });

  it('lists the tool where the turn can see it', () => {
    assert.match(TOOL_HINT, /workspace_info/);
  });

  it('teaches it in the base prompt, remote access included', () => {
    const prompt = readFileSync(new URL('../base_prompt.md', import.meta.url), 'utf8');
    assert.match(prompt, /`workspace_info`/);
    assert.match(prompt, /unknown\*\* until/);
  });
});

describe('a tool server the harness did not wire up', () => {
  it('says so rather than answering about the wrong directory', async () => {
    // The bridge process's own cwd is the harness's, not the agent's, so a
    // plausible-looking wrong answer is the one thing not to give here.
    const bridge = await startBridge({ ready: { scopes: [] } } as unknown as Gateway);
    try {
      const response = await fetch(bridge.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-quintal-token': bridge.token },
        body: JSON.stringify({ tool: 'workspace_info', args: {} }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      assert.equal(payload.ok, false);
      assert.match(payload.error ?? '', /answered by the harness/);
    } finally {
      await bridge.close();
    }
  });
});

/**
 * The whole path, once: a running agent calls the tool the way the MCP server
 * does, and the answer comes back from the harness that spawned it.
 */
describe('calling it as an agent does', () => {
  let current: AgentRunner | null = null;

  after(async () => {
    const runner = current;
    current = null;
    await runner?.stop();
    delete process.env.FAKE_RECORD;
    delete process.env.FAKE_TOOL_CALL;
    delete process.env.FAKE_REPLY;
    delete process.env.FAKE_MODELS;
  });

  it('answers one call with the directory, the checkouts and the scopes', async () => {
    const repos = temp('repos');
    checkout(repos, 'quintal', 'https://x-access-token:ghp_NOTINTHEANSWER@github.com/joaoh82/quintal.git');
    const root = nest(repos);

    const record = join(temp('record'), 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    process.env.FAKE_TOOL_CALL = 'workspace_info:{}';
    process.env.FAKE_REPLY = 'I work in the shared workspace on joshs-laptop.';
    // The runtime has to offer the model the config asks for, or the agent
    // refuses to run at all and never gets as far as the tool.
    process.env.FAKE_MODELS = 'claude-opus-5';

    const said: string[] = [];
    const handlers: Record<string, (value: unknown) => void> = {};
    const ready = {
      agentId: 'agent-1',
      name: 'Bob',
      ownerUserId: 'owner-1',
      ownerName: 'Josh',
      description: '',
      instructions: '',
      scopes: ['chat', 'dm'],
      channels: [],
      teams: [],
      limits: { walkUpRadiusTiles: 4 },
    };
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
      occupants: () => [],
      channels: () => [],
      on: (event: string, handler: (value: unknown) => void) => {
        handlers[event] = handler;
      },
    } as unknown as Gateway;

    const config = {
      name: 'Bob',
      key: 'agent-key',
      harness: 'custom',
      command: [process.execPath, FAKE],
      cwd: root,
      url: 'http://localhost:0',
      mapId: 'hq',
      workspaceId: 'ws-1',
      runtimeId: 'claude-code',
      modelId: 'claude-opus-5',
    } as unknown as AgentConfig;

    current = new AgentRunner(config, undefined, gateway);
    await current.start();
    // What the supervisor tells every runner once the fleet is up.
    current.reportHost({ label: 'joshs-laptop', reposDir: repos });

    const started = Date.now();
    handlers.chat?.({
      from: 's-1',
      fromUserId: 'user-1',
      fromName: 'Josh',
      fromKind: 'human',
      text: 'Bob, where do you work and which repos can you see?',
      sentAt: Date.now(),
      distance: 1,
    });

    const deadline = Date.now() + 10_000;
    while (said.length === 0) {
      if (Date.now() > deadline) throw new Error('the agent never answered');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const elapsed = Date.now() - started;

    const results = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { method: string; params?: { result?: unknown } })
      .filter((entry) => entry.method === '_test/tool_result')
      .map((entry) => entry.params?.result as { ok: boolean; result?: Record<string, unknown> });

    assert.equal(results.length, 1, 'one tool call answered the question');
    const [answer] = results;
    assert.ok(answer?.ok, `the tool answered ok: ${JSON.stringify(answer)}`);

    const result = answer.result as unknown as WorkspaceReport;
    assert.equal(result.working_directory, root);
    assert.equal(result.repositories.path, repos);
    assert.deepEqual(result.repositories.checkouts, [
      { name: 'quintal', git: true, remote: 'github.com/joaoh82/quintal' },
    ]);
    assert.equal(result.runtime.machine, 'joshs-laptop');
    assert.equal(result.runtime.runtime, 'claude-code');
    assert.equal(result.runtime.model, 'claude-opus-5');
    assert.deepEqual(Object.keys(result.quintal_scopes.granted), ['chat', 'dm']);
    assert.ok(!JSON.stringify(result).includes('ghp_'), 'no credential reached the agent');
    // Not an assertion about the model's speed — it is a scripted agent — but
    // the harness's own share of the answer, which is a directory read.
    assert.ok(elapsed < 10_000, `answered in ${elapsed}ms`);
    assert.ok(existsSync(record));
  });
});
