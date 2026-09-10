import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  appendFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { nestRoot } from './config.js';
import { evictLegacyHostFile, hostFilePath } from './host.js';
import { NEST_AGENTS_MD } from './nest-agents.text.js';

/**
 * The nest: one workspace on this machine, shared by every agent that runs
 * here.
 *
 * Every agent's working directory is this one. What makes agents different
 * from each other is what the office already gives each of them — an owner's
 * instructions and a core memory — not a directory of their own. A guide one
 * agent writes is exactly the thing the next one should find, and a
 * repositories symlink per agent is bookkeeping for nothing.
 *
 * Nothing here is ever pushed into a prompt. The nest is pulled: the harness
 * reads `AGENTS.md` from its working directory the way it reads any other
 * instructions file, and everything else is read one file at a time when a
 * task calls for it. That is what keeps a workspace that grows for months
 * from costing more on every turn.
 *
 * Shape follows Buzz's, deliberately, with two folders fewer: no work logs
 * (the office keeps the channel history and the audit log, so "what happened"
 * already has a home the owner can read) and no outbox.
 */

/** Created empty, inside the root. `REPOS` is handled apart — see `ensureRepos`. */
export const NEST_DIRS = ['GUIDES', 'RESEARCH', 'PLANS', '.scratch'] as const;

/**
 * Bump when `nest_agents.md` changes in a way existing nests should pick up.
 * The static part of an existing `AGENTS.md` is rewritten only then; between
 * bumps an owner's edits to it survive.
 */
export const NEST_VERSION = 2;

const VERSION_FILE = '.nest-version';
const AGENTS_FILE = 'AGENTS.md';
const REPOS_DIR = 'REPOS';
const HOST_FILE = 'host.json';
const BEGIN_MARKER = '<!-- BEGIN QUINTAL MANAGED';
const END_MARKER = '<!-- END QUINTAL MANAGED -->';

export interface NestOptions {
  /** Defaults to `nestRoot()`. */
  root?: string;
  /**
   * Where this machine keeps repositories. `REPOS/` in the nest becomes a link
   * to it, so an agent works in the owner's own checkouts. Undefined, or the
   * nest's own `REPOS/`, means a real directory of its own.
   */
  reposDir?: string;
  office?: { url: string; hostLabel?: string };
  /** Agents assigned to this machine, for the roster the managed section shows. */
  agents?: readonly { name: string; runtime: string }[];
}

export interface NestResult {
  root: string;
  /** The path agents reach repositories by — always `<root>/REPOS`. */
  repos: string;
  /** True when this call made the nest; false when it was already there. */
  created: boolean;
  /** Things that could not be done as asked. Never fatal; the owner should know. */
  warnings: string[];
}

/**
 * Make the nest, or bring an existing one up to date. Idempotent, and cheap
 * enough to run on every fleet start and every roster change.
 *
 * `AGENTS.md` is written from the template the first time. After that, the
 * part above the managed markers is replaced only when `NEST_VERSION` moves,
 * the managed section between the markers is rewritten every time, and
 * anything below the end marker is the owner's and is never touched.
 */
export function ensureNest(options: NestOptions = {}): NestResult {
  const root = resolve(options.root ?? nestRoot());
  const warnings: string[] = [];

  // A symlink at the root would let something else on the machine decide
  // where every agent's working directory really is.
  if (isSymlink(root)) {
    throw new Error(`${root} is a symlink; refusing to use it as the agents' workspace`);
  }

  const created = !existsSync(root);
  mkdirSync(root, { recursive: true });
  ownerOnly(root);
  for (const dir of NEST_DIRS) {
    const path = join(root, dir);
    mkdirSync(path, { recursive: true });
    ownerOnly(path);
  }

  // Nothing secret in the workspace. The machine token used to live here,
  // and a token in cwd is a token the agent's own `ls` finds.
  const leaked = join(root, HOST_FILE);
  if (existsSync(leaked)) {
    const moved = evictLegacyHostFile(leaked, hostFilePath());
    // A move that failed is the one path back to the leak this exists to
    // close, so it is not a warning: nothing gets spawned into this
    // directory until the file is out of it.
    if (moved === null || existsSync(leaked)) {
      throw new Error(
        `${leaked} is a credential inside the agents' workspace and could not be moved; move it to ${hostFilePath()} yourself`,
      );
    }
    warnings.push(`moved ${leaked} to ${moved}: credentials do not live in the agents' workspace`);
  }

  const repos = ensureRepos(root, options.reposDir, warnings);
  writeAgentsFile(root, options, repos, warnings);

  return { root, repos: join(root, REPOS_DIR), created, warnings };
}

/** Where `REPOS/` points, or null when it is a directory of its own. */
export function reposTarget(root: string): string | null {
  const link = join(root, REPOS_DIR);
  if (!isSymlink(link)) return null;
  try {
    return resolve(root, readlinkSync(link));
  } catch {
    return null;
  }
}

// --- REPOS -----------------------------------------------------------------

/**
 * `REPOS/` is a link to the owner's repositories directory, or a real
 * directory when no such place was named.
 *
 * The cases, in the order they are checked:
 * - Nothing there: make the link, or the directory.
 * - A link already: re-point it if the target moved.
 * - An empty real directory, but a target was named: replace it with the link.
 * - A real directory with contents, and a target named: leave it. Somebody
 *   cloned into it, and replacing it would hide their work; say so instead.
 */
function ensureRepos(root: string, reposDir: string | undefined, warnings: string[]): string {
  const link = join(root, REPOS_DIR);
  const wanted = validReposTarget(root, link, reposDir, warnings);
  const state = stateOf(link);

  if (wanted === null) {
    if (state === 'symlink') unlinkSync(link);
    if (state !== 'dir') mkdirSync(link, { recursive: true });
    ownerOnly(link);
    return link;
  }

  if (state === 'symlink') {
    const current = reposTarget(root);
    if (current === wanted) return wanted;
    unlinkSync(link);
  } else if (state === 'dir') {
    if (readdirSync(link).length > 0) {
      warnings.push(
        `${link} is a directory with contents, so it was not replaced by a link to ${wanted}; ` +
          'move what is in it and start the fleet again for agents to see your repositories there',
      );
      return link;
    }
    rmdirSync(link);
  } else if (state === 'other') {
    warnings.push(`${link} is neither a directory nor a link; leaving it alone`);
    return link;
  }

  symlinkSync(wanted, link, process.platform === 'win32' ? 'junction' : 'dir');
  return wanted;
}

function validReposTarget(
  root: string,
  link: string,
  reposDir: string | undefined,
  warnings: string[],
): string | null {
  if (reposDir === undefined || reposDir.trim().length === 0) return null;
  const wanted = resolve(reposDir);
  if (wanted === link) return null;

  if (stateOf(wanted) !== 'dir') {
    warnings.push(`repositories directory ${wanted} does not exist; REPOS/ is a directory of its own`);
    return null;
  }
  // Pointing REPOS at the nest, at something the nest is inside, or at
  // something inside the nest, makes a loop an agent could walk forever.
  const inside = (outer: string, path: string) =>
    path.startsWith(outer.endsWith(sep) ? outer : outer + sep);
  if (wanted === root || inside(wanted, root)) {
    warnings.push(`repositories directory ${wanted} contains the workspace itself; REPOS/ is a directory of its own`);
    return null;
  }
  if (inside(root, wanted)) {
    warnings.push(`repositories directory ${wanted} is inside the workspace; REPOS/ is a directory of its own`);
    return null;
  }
  return wanted;
}

// --- AGENTS.md -------------------------------------------------------------

function writeAgentsFile(root: string, options: NestOptions, repos: string, warnings: string[]): void {
  const path = join(root, AGENTS_FILE);
  const versionPath = join(root, VERSION_FILE);
  const template = splitAtMarkers(NEST_AGENTS_MD);
  if (template === null) throw new Error('nest_agents.md has lost its managed-section markers');

  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const parts = existing === null ? null : splitAtMarkers(existing);

  if (existing !== null && parts === null) {
    // Somebody's own file, written without our markers. It is theirs; the
    // most we do is say why the office is not maintaining it.
    warnings.push(`${path} has no managed-section markers, so the office is leaving it alone`);
    return;
  }

  const staticStale = readVersion(versionPath) !== NEST_VERSION;
  const head = parts === null || staticStale ? template.head : parts.head;
  const tail = parts === null ? template.tail : parts.tail;
  const next = `${head}${BEGIN_MARKER}${template.beginRest}\n${renderManaged(root, options, repos)}\n${END_MARKER}${tail}`;

  if (existing !== next) writeFileSync(path, next);
  if (staticStale) writeFileSync(versionPath, `${NEST_VERSION}\n`);
}

interface Split {
  /** Everything before the begin marker. */
  head: string;
  /** The rest of the begin marker's line, so its wording is the template's. */
  beginRest: string;
  /** Everything after the end marker, including its newline. */
  tail: string;
}

function splitAtMarkers(text: string): Split | null {
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;

  const beginLineEnd = text.indexOf('\n', begin);
  const beginRest = text.slice(begin + BEGIN_MARKER.length, beginLineEnd === -1 ? end : beginLineEnd);
  return {
    head: text.slice(0, begin),
    beginRest,
    tail: text.slice(end + END_MARKER.length),
  };
}

function readVersion(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function renderManaged(root: string, options: NestOptions, repos: string): string {
  const lines: string[] = [];

  lines.push('## This machine', '');
  lines.push(`- Office: ${options.office?.url ?? 'not connected to an office'}`);
  if (options.office?.hostLabel) lines.push(`- This machine is "${options.office.hostLabel}" in the office.`);
  lines.push(
    repos === join(root, REPOS_DIR)
      ? '- `REPOS/` is a directory of its own; clone into it.'
      : `- \`REPOS/\` is the owner's ${repos}. Work in the checkouts already there.`,
  );

  lines.push('', '## Agents on this machine', '');
  const agents = [...(options.agents ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (agents.length === 0) {
    lines.push('None assigned yet.');
  } else {
    lines.push('| Name | Runtime | Address |', '| --- | --- | --- |');
    for (const agent of agents) {
      lines.push(`| ${cell(agent.name)} | ${cell(agent.runtime)} | @${cell(agent.name)} |`);
    }
  }

  lines.push('', '## Guides', '');
  const guides = listGuides(join(root, 'GUIDES'));
  if (guides.length === 0) {
    lines.push('None yet. The first is written when your owner tells you how to do something from now on.');
  } else {
    lines.push('Refreshed when the fleet starts; a guide written since is not listed yet.', '');
    for (const guide of guides) lines.push(`- \`GUIDES/${guide.file}\` — ${guide.title}`);
  }

  return lines.join('\n');
}

/** A table cell cannot contain the character that ends it. */
function cell(text: string): string {
  return text.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

function listGuides(dir: string): { file: string; title: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((file) => ({ file, title: titleOf(join(dir, file)) ?? file.replace(/\.md$/, '') }));
}

/** The `title:` line of a file's front matter, unquoted, or null. */
function titleOf(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('---')) return null;
  const close = text.indexOf('\n---', 3);
  if (close === -1) return null;
  const match = /^title:\s*(.+)$/m.exec(text.slice(3, close));
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^["'](.*)["']$/, '$1');
}

// --- guides ----------------------------------------------------------------

/** How long a guide's name may be, in characters, after normalising. */
const GUIDE_NAME_MAX = 64;

/**
 * The file a guide called `name` lives in: `code-review` → `CODE_REVIEW.md`.
 *
 * Owners type names the way they think of them; files follow the workspace's
 * one convention so an agent can find them by eye. Null when nothing usable
 * is left — a name that was all punctuation, or nothing at all.
 */
export function guideFileName(name: string): string | null {
  const slug = name
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, GUIDE_NAME_MAX)
    .replace(/_+$/, '');
  return slug.length > 0 ? `${slug}.md` : null;
}

/** `CODE_REVIEW.md` → `Code review`: the title a fresh guide is given. */
export function guideTitle(file: string): string {
  const words = file.replace(/\.md$/i, '').toLowerCase().split('_').filter(Boolean);
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/**
 * Write a guide the owner dictated, or add to one that exists.
 *
 * Never replaces: a guide is the accumulated policy for one kind of work,
 * and an owner adding a rule in chat is adding, not starting over. A new
 * guide gets the workspace's front matter and a title; an existing one gets
 * the text as a dated section at the end, so the order rules were given in
 * is the order they are read in.
 */
export function writeGuide(
  root: string,
  name: string,
  body: string,
  now: Date = new Date(),
): { file: string; path: string; created: boolean } {
  const file = guideFileName(name);
  if (file === null) throw new Error(`"${name}" does not make a guide name`);
  const text = body.trim();
  if (text.length === 0) throw new Error('a guide needs a body');

  const dir = join(root, 'GUIDES');
  mkdirSync(dir, { recursive: true });
  ownerOnly(dir);
  const path = join(dir, file);
  const day = now.toISOString().slice(0, 10);

  if (existsSync(path)) {
    appendFileSync(path, `\n## Added ${day}\n\n${text}\n`);
    return { file, path, created: false };
  }

  const title = guideTitle(file);
  writeFileSync(
    path,
    [
      '---',
      `title: "${title.replace(/"/g, "'")}"`,
      'tags: [owner]',
      'status: active',
      `created: ${day}`,
      '---',
      '',
      `# ${title}`,
      '',
      text,
      '',
    ].join('\n'),
  );
  return { file, path, created: true };
}

// --- filesystem odds and ends ----------------------------------------------

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function stateOf(path: string): 'none' | 'symlink' | 'dir' | 'other' {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isDirectory()) return 'dir';
    return 'other';
  } catch {
    return 'none';
  }
}

/** Owner-only, where the platform can express it. Agents write here; nobody else reads it. */
function ownerOnly(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o700);
  } catch {
    // A filesystem that refuses modes still holds the files.
  }
}
