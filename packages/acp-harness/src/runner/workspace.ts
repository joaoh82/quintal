import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentScope } from '@quintal/shared';

/**
 * What this machine is, answered once instead of guessed at.
 *
 * An agent asked "where do you work?", "which repos can you see?" or "are you
 * allowed to do that?" has, until now, had to find out the way a person would
 * at a strange terminal: `pwd`, `ls`, `ls REPOS`, `git remote -v`, each one a
 * round trip, several of them failing because the directory it guessed at is
 * not there. That is a shell session's worth of tokens and seconds to produce
 * facts the harness already holds.
 *
 * So the harness answers instead. Not the office: the office is a server
 * somewhere else and cannot see a laptop's filesystem, which is why this is
 * resolved here and pushed nowhere. It is a *pull* — the same bargain as the
 * rest of the agent's senses. Nothing here costs a turn that does not ask.
 *
 * Deliberately separate from `look_around`, which is about the room: an agent
 * checking who is nearby should not pay for a directory listing.
 *
 * Two rules shape what comes back:
 *
 * - **Only what the agent's own work needs.** The working directory, the
 *   repositories directory it was pointed at, and what is directly inside
 *   that. Not the home directory, not a recursive walk, not anything on this
 *   machine that belongs to somebody else's software.
 * - **Local configuration is not remote permission.** A checkout on disk says
 *   somebody cloned it once. It says nothing about whether *this* runtime can
 *   read, push or open a PR against it today. Nothing here contacts a remote
 *   to find out; finding out is a deliberate, authenticated step the agent
 *   takes with the credentials its runtime already has.
 */

/** Directories listed under the repositories directory before the list is cut. */
export const MAX_CHECKOUTS = 60;

/** A `.git/config` larger than this is not one we are going to parse. */
const MAX_GIT_CONFIG_BYTES = 256 * 1024;

export interface WorkspaceIdentity {
  /** The agent, by the name the office knows it under. */
  agent: string;
  /** The human accountable for it. */
  owner: string;
  /** The runtime it is running on — a catalogue id, or the harness name. */
  runtime: string;
  /** The model it was told to ask for, or null for the runtime's default. */
  model: string | null;
  /** The name this machine answers to in the office. */
  machine: string;
}

export interface WorkspaceReportInput {
  /** The agent's working directory, as the harness configured it. */
  cwd: string;
  /** Scopes exactly as the office granted them in `agent:ready`. */
  scopes: readonly AgentScope[];
  identity: WorkspaceIdentity;
  /**
   * Where this machine keeps repositories, when it told the office so. Used
   * only when the working directory has no `REPOS/` of its own — an agent
   * rooted in a single checkout still works on a machine with a repositories
   * directory, and refusing to name it would be a lie by omission.
   */
  reposDir?: string;
  /** Overridable for the tests; there is no reason to pass it otherwise. */
  limit?: number;
}

export interface Checkout {
  name: string;
  /** True when it has a `.git` — anything else is just a directory sitting there. */
  git: boolean;
  /**
   * The `origin` remote as host and path, with any credentials in it dropped.
   * Absent when there is none, when it is a local path, or when it is not a
   * shape we recognise — better silent than leaking a URL with a token in it.
   */
  remote?: string;
}

export interface WorkspaceReport {
  working_directory: string;
  /**
   * Set when the working directory is itself a checkout — which it is for an
   * agent rooted in one repository rather than in the shared workspace. The
   * `origin` remote, redacted like any other, or a plain statement when there
   * is none to name.
   */
  working_directory_repo?: string;
  /** Said only when there is something to say: a file that is not there is noise. */
  agents_md?: string;
  repositories: {
    /** Absolute path, or null when this machine has no repositories directory. */
    path: string | null;
    /** How the agent reaches it from where it stands. */
    reached_as?: string;
    checkouts?: Checkout[];
    /** Set when the directory holds more than one call is willing to list. */
    more?: number;
    /** Why the list is empty or absent. */
    note?: string;
  };
  runtime: WorkspaceIdentity & { platform: string };
  quintal_scopes: {
    granted: Record<string, string>;
    not_granted: Record<string, string>;
    unscoped: string;
  };
  external_access: {
    verified: string;
    note: string;
  };
}

/**
 * What each scope actually lets the agent do, in the terms it would use to
 * tell somebody. The office's word `status` means nothing to a model reading
 * it cold; "set your status line" does.
 */
const SCOPE_MEANING: Record<AgentScope, string> = {
  chat: 'speak aloud and post in channels and direct messages (`say`)',
  move: 'walk to a person or a zone (`move_to`)',
  status: 'set your status line and show an emote (`set_status`, `emote`)',
  dm: 'take part in direct messages at all',
  run: 'your harness may approve the runtime\'s own "may I run this?" questions for you; without it each one is put to your owner, and silence denies',
};

const ALL_SCOPES = Object.keys(SCOPE_MEANING) as AgentScope[];

const EXTERNAL_NOTE =
  'This report reads only this machine, and never contacts a remote. A checkout ' +
  'here, or a git remote on it, shows that somebody cloned it — not that you can ' +
  'read, push or open a pull request against it now. Treat any access outside this ' +
  'machine as unknown until you check it deliberately, with the credentials your ' +
  'runtime already holds (`gh auth status`, `git ls-remote`, the API you were given). ' +
  'Say it is unknown rather than assuming either way.';

export function workspaceReport(input: WorkspaceReportInput): WorkspaceReport {
  const limit = input.limit ?? MAX_CHECKOUTS;
  const granted = new Set(input.scopes);
  const here = isDir(input.cwd);

  const report: WorkspaceReport = {
    working_directory: here ? input.cwd : `${input.cwd} — this directory is not on this machine`,
    repositories: repositories(input.cwd, input.reposDir, limit),
    runtime: { ...input.identity, platform: process.platform },
    quintal_scopes: {
      granted: Object.fromEntries(
        ALL_SCOPES.filter((scope) => granted.has(scope)).map((scope) => [scope, SCOPE_MEANING[scope]]),
      ),
      not_granted: Object.fromEntries(
        ALL_SCOPES.filter((scope) => !granted.has(scope)).map((scope) => [scope, SCOPE_MEANING[scope]]),
      ),
      unscoped:
        'look_around, who_is_here, messages_get, memory_get, memory_set and this tool ' +
        'need no scope: they change nothing anybody else can see.',
    },
    external_access: { verified: 'nothing', note: EXTERNAL_NOTE },
  };

  if (here && isGitCheckout(input.cwd)) {
    report.working_directory_repo =
      originRemote(input.cwd) ?? 'a git checkout, with no origin remote this can name';
  }
  if (here && existsSync(join(input.cwd, 'AGENTS.md'))) {
    report.agents_md = 'AGENTS.md is in your working directory. Read it once per session.';
  }
  return report;
}

/**
 * Where the repositories are, and what is in them.
 *
 * The order is the order of authority: `REPOS/` in the working directory is
 * what the agent was actually given, so it wins over what the machine reported
 * about itself. An agent rooted in one checkout has neither, and the machine's
 * own repositories directory is the honest answer.
 */
function repositories(
  cwd: string,
  reposDir: string | undefined,
  limit: number,
): WorkspaceReport['repositories'] {
  const link = join(cwd, 'REPOS');
  const linked = symlinkTarget(cwd, link);

  if (linked !== null) return listing(linked, 'REPOS/', limit);
  if (isDir(link)) return listing(link, 'REPOS/', limit);

  const configured = reposDir?.trim();
  if (configured && configured.length > 0) {
    const path = resolve(configured);
    return listing(path, path, limit);
  }

  // Not a nest and no repositories directory reported: the working directory
  // is all there is, and saying so beats sending the agent looking for a
  // `REPOS/` that was never made.
  return { path: null, note: 'no repositories directory on this machine' };
}

function listing(path: string, reachedAs: string, limit: number): WorkspaceReport['repositories'] {
  if (!isDir(path)) {
    return { path, reached_as: reachedAs, note: 'this directory is not there' };
  }

  let names: string[];
  try {
    names = readdirSync(path, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isDir(join(path, entry.name))))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return { path, reached_as: reachedAs, note: 'this directory could not be read' };
  }

  if (names.length === 0) {
    return { path, reached_as: reachedAs, note: 'nothing cloned here yet' };
  }

  const checkouts = names.slice(0, limit).map((name): Checkout => {
    const dir = join(path, name);
    const git = isGitCheckout(dir);
    const remote = git ? originRemote(dir) : null;
    return remote === null ? { name, git } : { name, git, remote };
  });

  const result: WorkspaceReport['repositories'] = { path, reached_as: reachedAs, checkouts };
  if (names.length > checkouts.length) result.more = names.length - checkouts.length;
  return result;
}

/** The target of a symlink, or null when the path is not one. */
function symlinkTarget(from: string, path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(from, readlinkSync(path));
  } catch {
    return null;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGitCheckout(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * The `origin` URL from a checkout's own config, read rather than shelled out
 * for: sixty `git remote -v` subprocesses to answer one question is exactly
 * the exploration this tool exists to replace.
 *
 * A worktree or submodule keeps a `.git` file pointing elsewhere; those get no
 * remote rather than a path walk to find one.
 */
function originRemote(dir: string): string | null {
  const path = join(dir, '.git', 'config');
  try {
    if (statSync(path).size > MAX_GIT_CONFIG_BYTES) return null;
    return redactRemote(urlOfOrigin(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** The `url` of `[remote "origin"]`, or null when the file has no such section. */
export function urlOfOrigin(config: string): string | null {
  const lines = config.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]/.test(trimmed);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(trimmed);
    if (match) return match[1]!.trim();
  }
  return null;
}

/**
 * A remote as `host/path`, or null.
 *
 * Everything else is dropped on purpose. A remote URL is the one field here
 * that can carry a credential — `https://x-access-token:ghp_…@github.com/o/r`
 * is what a token-authenticated clone leaves in `.git/config` — and a local
 * path remote is a directory elsewhere on the owner's machine, which is not
 * this tool's to hand out. Returning less is the whole point: an agent needs
 * to recognise the repository, not to be handed a way to authenticate as it.
 */
export function redactRemote(url: string | null): string | null {
  if (url === null) return null;
  const raw = url.trim();
  if (raw.length === 0 || raw.length > 512) return null;

  // scp-style: git@github.com:owner/repo.git
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}):(?!\/)(\S+)$/.exec(raw);
  if (scp) return tidy(scp[1]!, scp[2]!);

  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(raw);
  if (!scheme) return null;
  if (!['http', 'https', 'ssh', 'git'].includes(scheme[1]!.toLowerCase())) return null;

  const rest = scheme[2]!;
  const at = rest.lastIndexOf('@', rest.indexOf('/') === -1 ? rest.length : rest.indexOf('/'));
  const afterUserInfo = at === -1 ? rest : rest.slice(at + 1);
  const slash = afterUserInfo.indexOf('/');
  if (slash === -1) return null;

  const host = afterUserInfo.slice(0, slash).split(':')[0]!;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  return tidy(host, afterUserInfo.slice(slash + 1));
}

function tidy(host: string, path: string): string | null {
  const cleaned = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // A query string or a fragment has no business in a remote and is the shape
  // a token smuggled as a parameter would take.
  if (cleaned.length === 0 || /[?#@\s]/.test(cleaned)) return null;
  return `${host}/${cleaned}`;
}
