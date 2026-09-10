import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { configDir, nestRoot } from '../src/config.js';
import { hostFilePath, readStoredHost, writeStoredHost } from '../src/host.js';
import { NEST_DIRS, NEST_VERSION, ensureNest, reposTarget } from '../src/nest.js';
import { workspaceSection } from '../src/runner/AgentRunner.js';

/**
 * The nest is the one directory every agent on a machine works in, and
 * `AGENTS.md` inside it is the first thing an agent reads each session. These
 * pin down that it is made once, kept current without clobbering anybody's
 * edits, and points `REPOS/` at the owner's checkouts.
 */

const scratch: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quintal-nest-'));
  scratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function agentsMd(root: string): string {
  return readFileSync(join(root, 'AGENTS.md'), 'utf8');
}

describe('making the nest', () => {
  it('creates the root, its folders and AGENTS.md from the template', () => {
    const root = join(tmp(), '.quintal');
    const result = ensureNest({ root });

    assert.equal(result.created, true);
    assert.deepEqual(result.warnings, []);
    for (const dir of NEST_DIRS) assert.ok(statSync(join(root, dir)).isDirectory(), dir);
    assert.ok(statSync(join(root, 'REPOS')).isDirectory(), 'REPOS is a real directory by default');

    const text = agentsMd(root);
    assert.match(text, /^# Your workspace/);
    assert.match(text, /GUIDES\//);
    assert.match(text, /BEGIN QUINTAL MANAGED/);
    assert.match(text, /END QUINTAL MANAGED/);
    assert.match(text, /None assigned yet/);
    assert.equal(readFileSync(join(root, '.nest-version'), 'utf8').trim(), String(NEST_VERSION));
  });

  it('is owner-only', { skip: process.platform === 'win32' }, () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root });
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, 'GUIDES')).mode & 0o777, 0o700);
  });

  it('refuses a symlink where the root should be', () => {
    const dir = tmp();
    const real = join(dir, 'real');
    mkdirSync(real);
    const root = join(dir, '.quintal');
    symlinkSync(real, root, 'dir');
    assert.throws(() => ensureNest({ root }), /symlink/);
  });

  it('reports the office, the machine and the agents in the managed section', () => {
    const root = join(tmp(), '.quintal');
    ensureNest({
      root,
      office: { url: 'http://office.test', hostLabel: 'laptop' },
      agents: [
        { name: 'Marvin', runtime: 'Claude Code' },
        { name: 'Arthur', runtime: 'Codex' },
      ],
    });
    const text = agentsMd(root);
    assert.match(text, /Office: http:\/\/office\.test/);
    assert.match(text, /"laptop"/);
    assert.match(text, /\| Arthur \| Codex \| @Arthur \|/);
    assert.match(text, /\| Marvin \| Claude Code \| @Marvin \|/);
    assert.ok(text.indexOf('| Arthur') < text.indexOf('| Marvin'), 'roster is sorted by name');
  });

  it('honours QUINTAL_NEST_DIR', () => {
    const previous = process.env.QUINTAL_NEST_DIR;
    process.env.QUINTAL_NEST_DIR = '/somewhere/else';
    try {
      assert.equal(nestRoot(), '/somewhere/else');
    } finally {
      if (previous === undefined) delete process.env.QUINTAL_NEST_DIR;
      else process.env.QUINTAL_NEST_DIR = previous;
    }
  });
});

describe('keeping the nest current', () => {
  it('is idempotent', () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root, agents: [{ name: 'Bob', runtime: 'Goose' }] });
    const first = agentsMd(root);
    const again = ensureNest({ root, agents: [{ name: 'Bob', runtime: 'Goose' }] });
    assert.equal(again.created, false);
    assert.equal(agentsMd(root), first);
  });

  it('rewrites the managed section and keeps what the owner wrote below it', () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root, agents: [{ name: 'Bob', runtime: 'Goose' }] });
    writeFileSync(join(root, 'AGENTS.md'), `${agentsMd(root)}\n## House rules\n\nTests before commits.\n`);

    ensureNest({ root, agents: [{ name: 'Alice', runtime: 'Codex' }] });
    const text = agentsMd(root);
    assert.match(text, /\| Alice \| Codex \|/);
    assert.doesNotMatch(text, /\| Bob \|/, 'the old roster is gone');
    assert.match(text, /## House rules\n\nTests before commits\./, 'the tail survives');
    assert.equal(text.split('BEGIN QUINTAL MANAGED').length, 2, 'one managed section');
  });

  it('keeps an edited head until the template version moves, then replaces it', () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root });
    const edited = agentsMd(root).replace('# Your workspace', '# Our workspace');
    writeFileSync(join(root, 'AGENTS.md'), edited);

    ensureNest({ root });
    assert.match(agentsMd(root), /^# Our workspace/, 'same version: the edit stays');

    writeFileSync(join(root, '.nest-version'), '0\n');
    ensureNest({ root });
    assert.match(agentsMd(root), /^# Your workspace/, 'new version: the template is back');
    assert.equal(readFileSync(join(root, '.nest-version'), 'utf8').trim(), String(NEST_VERSION));
  });

  it('leaves an AGENTS.md without markers alone and says so', () => {
    const root = join(tmp(), '.quintal');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '# Mine\n');
    const result = ensureNest({ root });
    assert.equal(agentsMd(root), '# Mine\n');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /markers/);
  });

  it('lists the guides by their front-matter title', () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root });
    writeFileSync(
      join(root, 'GUIDES', 'CODE_REVIEW.md'),
      '---\ntitle: "How to review a pull request"\ntags: [review]\n---\n\n# Review\n',
    );
    writeFileSync(join(root, 'GUIDES', 'RELEASE.md'), '# No front matter here\n');
    ensureNest({ root });
    const text = agentsMd(root);
    assert.match(text, /- `GUIDES\/CODE_REVIEW\.md` — How to review a pull request/);
    assert.match(text, /- `GUIDES\/RELEASE\.md` — RELEASE/);
    assert.doesNotMatch(text, /None yet/);
  });
});

describe('REPOS', () => {
  it('links to the repos directory when one is given', () => {
    const dir = tmp();
    const repos = join(dir, 'projects');
    mkdirSync(repos);
    const root = join(dir, '.quintal');
    const result = ensureNest({ root, reposDir: repos });

    assert.ok(lstatSync(join(root, 'REPOS')).isSymbolicLink());
    assert.equal(reposTarget(root), repos);
    assert.equal(result.repos, join(root, 'REPOS'));
    assert.match(agentsMd(root), /`REPOS\/` is the owner's/);
  });

  it('re-points the link when the repos directory moves', () => {
    const dir = tmp();
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    mkdirSync(first);
    mkdirSync(second);
    const root = join(dir, '.quintal');
    ensureNest({ root, reposDir: first });
    ensureNest({ root, reposDir: second });
    assert.equal(reposTarget(root), second);
  });

  it('replaces an empty REPOS directory with the link, and keeps a full one', () => {
    const dir = tmp();
    const repos = join(dir, 'projects');
    mkdirSync(repos);
    const root = join(dir, '.quintal');
    ensureNest({ root });
    assert.ok(statSync(join(root, 'REPOS')).isDirectory());

    let result = ensureNest({ root, reposDir: repos });
    assert.ok(lstatSync(join(root, 'REPOS')).isSymbolicLink(), 'empty directory gave way to the link');
    assert.deepEqual(result.warnings, []);

    // Now the other way: a real directory somebody cloned into.
    unlinkSync(join(root, 'REPOS'));
    mkdirSync(join(root, 'REPOS', 'api'), { recursive: true });
    result = ensureNest({ root, reposDir: repos });
    assert.ok(statSync(join(root, 'REPOS')).isDirectory(), 'left as it was');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /contents/);
  });

  it('falls back to a directory of its own when the repos directory is missing or contains the nest', () => {
    const dir = tmp();
    const root = join(dir, '.quintal');

    let result = ensureNest({ root, reposDir: join(dir, 'nowhere') });
    assert.ok(statSync(join(root, 'REPOS')).isDirectory());
    assert.match(result.warnings[0] ?? '', /does not exist/);

    result = ensureNest({ root, reposDir: dir });
    assert.ok(statSync(join(root, 'REPOS')).isDirectory());
    assert.match(result.warnings[0] ?? '', /contains the workspace/);

    result = ensureNest({ root, reposDir: join(root, 'GUIDES') });
    assert.ok(statSync(join(root, 'REPOS')).isDirectory());
    assert.match(result.warnings[0] ?? '', /inside the workspace/);
  });

  it('is owner-only when it is a directory of its own', { skip: process.platform === 'win32' }, () => {
    const root = join(tmp(), '.quintal');
    ensureNest({ root });
    assert.equal(statSync(join(root, 'REPOS')).mode & 0o777, 0o700);
  });

  it('reverts to a directory of its own when the repos directory is unset again', () => {
    const dir = tmp();
    const repos = join(dir, 'projects');
    mkdirSync(repos);
    const root = join(dir, '.quintal');
    ensureNest({ root, reposDir: repos });
    ensureNest({ root });
    assert.equal(lstatSync(join(root, 'REPOS')).isSymbolicLink(), false);
    assert.ok(statSync(join(root, 'REPOS')).isDirectory());
  });
});

describe('the machine credential is never in the workspace', () => {
  // The token `login` remembers used to live at `~/.quintal/host.json`, which
  // was harmless while agents worked in a repository and a leak the moment
  // `~/.quintal` was their working directory: a file mode hides it from other
  // users, not from a process running as the same one, and `ls` in cwd is the
  // first thing an agent does.

  function withDirs(run: (root: string, config: string) => void): void {
    const dir = tmp();
    const root = join(dir, '.quintal');
    const config = join(dir, 'config', 'quintal');
    const previous = process.env.QUINTAL_CONFIG_DIR;
    process.env.QUINTAL_CONFIG_DIR = config;
    try {
      run(root, config);
    } finally {
      if (previous === undefined) delete process.env.QUINTAL_CONFIG_DIR;
      else process.env.QUINTAL_CONFIG_DIR = previous;
    }
  }

  it('writes the token to the config directory, not the nest', () => {
    withDirs((root, config) => {
      ensureNest({ root });
      const path = writeStoredHost({ token: 'qh_test', url: 'http://office.test' });
      assert.equal(path, join(config, 'host.json'));
      assert.equal(hostFilePath(), path);
      assert.equal(existsSync(join(root, 'host.json')), false);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readStoredHost()?.token, 'qh_test');
    });
  });

  it('moves a token found in the nest out of it', () => {
    withDirs((root, config) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'host.json'), JSON.stringify({ token: 'qh_old', url: 'http://x' }));

      const result = ensureNest({ root });

      assert.equal(existsSync(join(root, 'host.json')), false, 'gone from cwd');
      assert.equal(JSON.parse(readFileSync(join(config, 'host.json'), 'utf8')).token, 'qh_old');
      assert.equal(statSync(join(config, 'host.json')).mode & 0o777, 0o600);
      assert.ok(result.warnings.some((line) => /moved .*host\.json/.test(line)), 'says it did');
    });
  });

  it('defaults the config directory under ~/.config', () => {
    const previous = { cfg: process.env.QUINTAL_CONFIG_DIR, xdg: process.env.XDG_CONFIG_HOME };
    delete process.env.QUINTAL_CONFIG_DIR;
    try {
      process.env.XDG_CONFIG_HOME = '/xdg';
      assert.equal(configDir(), '/xdg/quintal');
      delete process.env.XDG_CONFIG_HOME;
      assert.match(configDir(), /\/\.config\/quintal$/);
    } finally {
      if (previous.cfg !== undefined) process.env.QUINTAL_CONFIG_DIR = previous.cfg;
      if (previous.xdg !== undefined) process.env.XDG_CONFIG_HOME = previous.xdg;
    }
  });
});

describe('what the system prompt says about the workspace', () => {
  it('names the directory, and AGENTS.md and REPOS/ only when they are there', () => {
    const plain = tmp();
    const bare = workspaceSection(plain);
    assert.match(bare, /\[Workspace\]/);
    assert.match(bare, new RegExp(`Your working directory is ${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(bare, /AGENTS\.md/);
    assert.doesNotMatch(bare, /REPOS/);

    const root = join(tmp(), '.quintal');
    ensureNest({ root });
    const full = workspaceSection(root);
    assert.match(full, /Read AGENTS\.md there once per session/);
    assert.match(full, /Repositories are under REPOS\//);
    assert.ok(existsSync(join(root, 'AGENTS.md')));
  });
});
