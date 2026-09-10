import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  AGENT_PARALLELISM_MAX,
  AGENT_PARALLELISM_MIN,
  RUNTIMES,
  acpCommandFor,
  runtimeById,
} from '@quintal/shared';

import { noteSecretEnv } from './secrets.js';

/**
 * How a fleet is declared.
 *
 * The primary user runs 3–10 agents across mixed harnesses, so the file format
 * is the main interface and the single-agent CLI flags are the special case,
 * not the other way round.
 */

/**
 * Harnesses we know how to spawn without being told a command.
 *
 * Derived from the shared catalogue rather than written out here. The list used
 * to be a hand-maintained array, and it drifted: the office listed `gemini`,
 * `opencode` and `omp` as usable runtimes while this file had never heard of
 * them, so the settings page said "ready" and the spawn said "unknown harness".
 * One catalogue, one answer.
 *
 * `custom` is not a runtime — it is the escape hatch for a command somebody
 * supplies themselves, so it is appended rather than found.
 */
export const CUSTOM_HARNESS = 'custom';

export const KNOWN_HARNESSES: readonly string[] = [
  ...RUNTIMES.filter((runtime) => runtime.acp.kind !== 'none').map((runtime) => runtime.id),
  CUSTOM_HARNESS,
];

/**
 * A harness id this build can actually launch.
 *
 * `Harness` is a plain string now that the list is computed. The literal union
 * it used to be looked like type safety and was not: it made `defaultCommandFor`
 * an exhaustive switch over a list that was simply *wrong*, and exhaustiveness
 * over the wrong set compiles perfectly.
 */
export type Harness = string;

export function isHarness(value: string): boolean {
  return KNOWN_HARNESSES.includes(value);
}

export interface AgentConfig {
  name: string;
  /**
   * Resolved at load time from `key` or `keyEnv`. Never written back to disk.
   *
   * An `nsec1…` or 64 hex characters is the agent's own secret key
   * (credentials v2); a `qa_…` string is a legacy key. Empty when this agent
   * was defined in the office and no key was supplied for it: there the
   * credential is the machine's `hostToken` plus `agentId`. See
   * `credentialFor` for which one a join presents.
   */
  key: string;
  /** Machine credential, for an office-defined agent. */
  hostToken?: string;
  /** Which agent this machine is acting as. Paired with `hostToken`. */
  agentId?: string;
  harness: Harness;
  /** Command line for the ACP agent. Required for `custom`. */
  command: string[];
  /**
   * The agent's working directory: the nest (see `nest.ts`), unless a fleet
   * file or the CLI named somewhere else on purpose. Code context comes from
   * here and never from Quintal — see `docs/GATEWAY.md`.
   */
  cwd: string;
  /**
   * The catalogue id of the runtime an office-defined agent runs on, for the
   * roster the nest's `AGENTS.md` shows. Undefined when the fleet file named
   * the harness itself; `harness` is the answer then.
   */
  runtimeId?: string;
  url: string;
  mapId: string;
  /**
   * The office this agent belongs to. Rooms are per-office, so without it a
   * join has no room to ask for — and the office refuses one that guesses.
   *
   * Empty for a standalone `--agent` run, where the office resolves it from
   * the agent key rather than being told.
   */
  workspaceId: string;
  /**
   * A fingerprint of the description and instructions the office holds for this
   * agent, or empty when it was not defined in an office.
   *
   * Compared, never read. An agent is told what it is in `agent:ready`, at
   * connect — so when its owner edits that, the only way a *running* agent
   * learns is by being restarted, and this is what tells the supervisor to.
   */
  profile: string;
  /**
   * The model to ask the runtime for, by the id it advertises over ACP.
   * Undefined for the runtime's default. Applied with
   * `session/set_config_option` after every `session/new`, never as a flag —
   * and an agent not offered it refuses to run rather than running on
   * another.
   */
  modelId?: string;
  /**
   * How many conversations this agent may answer at once — the size of its
   * pool of runtime processes. Undefined defers to what the office says in
   * `agent:ready`, which is the agent's own setting or the office default.
   * From a fleet file or `--parallelism`, it overrides the office: the
   * machine running the processes has the last word on how many.
   */
  parallelism?: number;
}

export interface FleetConfig {
  url: string;
  mapId: string;
  /** Root that `repo` names resolve against. */
  reposDir: string;
  agents: AgentConfig[];
}

interface RawAgent {
  name?: unknown;
  key?: unknown;
  keyEnv?: unknown;
  agent?: unknown;
  cmd?: unknown;
  cwd?: unknown;
  repo?: unknown;
  model?: unknown;
  parallelism?: unknown;
}

interface RawFleet {
  url?: unknown;
  mapId?: unknown;
  reposDir?: unknown;
  agents?: unknown;
}

/**
 * Where your projects live.
 *
 * Agents reach it as `REPOS/` in the nest. A fleet file that roots one agent
 * in a single checkout on purpose can say `"repo": "api"` and have it resolved
 * here rather than spelling out the path.
 *
 * Default follows the convention: `~/projects`, overridable per fleet or by
 * QUINTAL_REPOS_DIR.
 */
export const DEFAULT_REPOS_DIRNAME = 'projects';

export function defaultReposDir(): string {
  return process.env.QUINTAL_REPOS_DIR ?? join(homedir(), DEFAULT_REPOS_DIRNAME);
}

/**
 * Where every agent on this machine works: the nest, `~/.quintal`.
 *
 * Override with `QUINTAL_NEST_DIR` — for a development build of the desktop
 * app that must not share a workspace with the installed one, and for tests.
 *
 * Nothing secret lives here. It is the agents' working directory, and a
 * credential in an agent's working directory is a credential the agent's
 * own tools can read — see `configDir` for where the machine token goes.
 */
export const NEST_DIRNAME = '.quintal';

export function nestRoot(): string {
  const override = process.env.QUINTAL_NEST_DIR?.trim();
  return override ? expandHome(override) : join(homedir(), NEST_DIRNAME);
}

/**
 * Where this machine's own configuration lives: `host.json`, the fleet
 * token `quintal-acp login` remembers.
 *
 * `~/.config/quintal` (or `$XDG_CONFIG_HOME/quintal`), deliberately not the
 * nest. The token used to sit at `~/.quintal/host.json`, which was fine while
 * agents worked in a repository and became a hole the moment `~/.quintal` was
 * their working directory: `0o600` hides a file from other users, not from a
 * process running as the same one, and `ls` in cwd is the first thing an
 * agent does. Override with `QUINTAL_CONFIG_DIR` for tests.
 */
export function configDir(): string {
  const override = process.env.QUINTAL_CONFIG_DIR?.trim();
  if (override) return expandHome(override);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'quintal');
}

/** Expand a leading `~` so config files can use it. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export const FLEET_FILENAMES = ['quintal.fleet.json', '.quintal/fleet.json'] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Default command lines for the harnesses we know.
 *
 * Claude Code and Codex don't speak ACP natively — they're wrapped by adapters
 * published for exactly this purpose, which is why these are `npx` lines rather
 * than the bare binaries. Goose speaks ACP itself.
 */
export function defaultCommandFor(harness: Harness): string[] {
  if (harness === CUSTOM_HARNESS) {
    throw new ConfigError('agent "custom" requires an explicit cmd');
  }

  const spec = runtimeById(harness);
  const command = spec ? acpCommandFor(spec) : null;
  if (!command) {
    throw new ConfigError(
      `unknown harness "${harness}" — expected ${KNOWN_HARNESSES.join(' | ')}`,
    );
  }
  return command;
}

/** Split a command string the way a shell would, minus the shell. */
export function splitCommand(command: string): string[] {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^["']|["']$/g, ''));
}

function requireString(value: unknown, field: string, agent: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigError(`agent "${agent}": ${field} is required`);
  }
  return value.trim();
}

function resolveKey(raw: RawAgent, name: string): string {
  if (typeof raw.key === 'string' && raw.key.trim().length > 0) return raw.key.trim();

  if (typeof raw.keyEnv === 'string' && raw.keyEnv.trim().length > 0) {
    const fromEnv = process.env[raw.keyEnv.trim()];
    if (!fromEnv || fromEnv.trim().length === 0) {
      throw new ConfigError(
        `agent "${name}": keyEnv "${raw.keyEnv}" is not set in the environment`,
      );
    }
    // The agent runtime inherits our environment; this variable must not be
    // part of what it inherits.
    noteSecretEnv(raw.keyEnv);
    return fromEnv.trim();
  }

  throw new ConfigError(
    `agent "${name}": needs a key — prefer keyEnv so the key stays out of the file`,
  );
}

export function parseFleet(raw: unknown, baseDir: string): FleetConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('fleet config must be a JSON object');
  }

  const fleet = raw as RawFleet;
  const url = typeof fleet.url === 'string' ? fleet.url : 'http://localhost:3000';
  const mapId = typeof fleet.mapId === 'string' ? fleet.mapId : 'hq';
  const reposDirRaw =
    typeof fleet.reposDir === 'string' && fleet.reposDir.trim().length > 0
      ? expandHome(fleet.reposDir.trim())
      : defaultReposDir();
  const reposDir = isAbsolute(reposDirRaw) ? reposDirRaw : resolve(baseDir, reposDirRaw);

  if (!Array.isArray(fleet.agents) || fleet.agents.length === 0) {
    throw new ConfigError('fleet config needs a non-empty "agents" array');
  }

  const seen = new Set<string>();
  const agents = fleet.agents.map((entry) => {
    const rawAgent = (entry ?? {}) as RawAgent;
    const name = requireString(rawAgent.name, 'name', String(rawAgent.name ?? '?'));

    if (seen.has(name)) throw new ConfigError(`duplicate agent name "${name}"`);
    seen.add(name);

    const harnessName = typeof rawAgent.agent === 'string' ? rawAgent.agent : 'custom';
    if (!isHarness(harnessName)) {
      throw new ConfigError(
        `agent "${name}": unknown harness "${harnessName}" — expected ${KNOWN_HARNESSES.join(' | ')}`,
      );
    }

    const command =
      typeof rawAgent.cmd === 'string' && rawAgent.cmd.trim().length > 0
        ? splitCommand(rawAgent.cmd)
        : defaultCommandFor(harnessName);

    // Refusing to guess a workspace is a safety rail, not a convenience check:
    // an agent's code context comes from its working directory, and one that
    // defaults to wherever the CLI happened to be launched is an agent editing
    // a repository nobody chose. `repo` is shorthand, not an exception — it
    // still names a specific directory, just relative to `reposDir`.
    //
    // `repo: "*"` is the deliberate opt-out, for the generalist you ask
    // arbitrary things: rooted at the repos directory itself, it can find a
    // checkout, or clone one it doesn't have yet. That is a genuinely wider
    // blast radius, which is why it has to be asked for by name — an agent
    // that gets it by forgetting to set `cwd` is the failure this rail exists
    // to prevent.
    // The nest unless this file says otherwise. `cwd` and `repo` are kept as
    // overrides for somebody who wrote them on purpose; an agent that names
    // neither works where every agent on this machine works.
    const repo = typeof rawAgent.repo === 'string' ? rawAgent.repo.trim() : '';
    const cwdRaw =
      repo.length > 0
        ? repo
        : typeof rawAgent.cwd === 'string' && rawAgent.cwd.trim().length > 0
          ? rawAgent.cwd.trim()
          : '';
    const cwd =
      repo.length > 0
        ? resolve(reposDir, expandHome(repo))
        : cwdRaw.length > 0
          ? isAbsolute(expandHome(cwdRaw))
            ? expandHome(cwdRaw)
            : resolve(baseDir, expandHome(cwdRaw))
          : nestRoot();

    // Check an override now, with the agent's name attached. Otherwise the
    // failure is a bare ENOENT from `spawn` several seconds later, after the
    // office connection is already open — and a relative cwd that resolved
    // against the wrong directory looks identical to a typo. The nest is not
    // checked: the fleet makes it before anything is spawned.
    if (cwdRaw.length > 0) assertDirectory(cwd, name, cwdRaw);

    const model = typeof rawAgent.model === 'string' ? rawAgent.model.trim() : '';
    const parallelism =
      rawAgent.parallelism === undefined || rawAgent.parallelism === null
        ? undefined
        : parseParallelism(rawAgent.parallelism, name);

    return {
      name,
      key: resolveKey(rawAgent, name),
      harness: harnessName,
      command,
      cwd,
      url,
      mapId,
      workspaceId: '',
      profile: '',
      ...(model.length > 0 ? { modelId: model } : {}),
      ...(parallelism !== undefined ? { parallelism } : {}),
    } satisfies AgentConfig;
  });

  return { url, mapId, reposDir, agents };
}

/**
 * A parallelism written by a person, checked rather than clamped: a fleet
 * file is edited by hand, and `"parallelism": 100` silently becoming 32 is
 * how somebody spends an afternoon wondering why the number does nothing.
 */
export function parseParallelism(raw: unknown, agent: string): number {
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (
    !Number.isInteger(value) ||
    value < AGENT_PARALLELISM_MIN ||
    value > AGENT_PARALLELISM_MAX
  ) {
    throw new ConfigError(
      `agent "${agent}": parallelism must be a whole number from ${AGENT_PARALLELISM_MIN} to ${AGENT_PARALLELISM_MAX}, not ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function assertDirectory(path: string, agent: string, asWritten: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new ConfigError(
      `agent "${agent}": cwd "${asWritten}" does not exist (resolved to ${path})`,
    );
  }
  if (!stats.isDirectory()) {
    throw new ConfigError(`agent "${agent}": cwd "${asWritten}" is not a directory`);
  }
}

export interface LoadedFleet extends FleetConfig {
  /** Where the config came from, for error messages. */
  path: string;
}

/**
 * The fleet file this directory would use, or null if there isn't one.
 *
 * Separate from `loadFleet` because "is there a local fleet?" is a question
 * asked *before* deciding whether to ask the office, and the answer must not be
 * an exception.
 */
export function findFleetFile(cwd: string): string | null {
  for (const name of FLEET_FILENAMES) {
    const path = resolve(cwd, name);
    try {
      statSync(path);
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

export function loadFleet(explicitPath: string | undefined, cwd: string): LoadedFleet {
  const candidates = explicitPath
    ? [isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath)]
    : FLEET_FILENAMES.map((name) => resolve(cwd, name));

  for (const path of candidates) {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      // Only keep looking when we were guessing. An explicit --config that
      // isn't there is an error about *that path*, not an invitation to search
      // somewhere else and report the search.
      if (explicitPath) {
        throw new ConfigError(`no fleet config at ${path}`);
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error: unknown) {
      throw new ConfigError(
        `${path} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      );
    }

    // Relative cwds resolve against the config file's own directory, not
    // wherever the CLI happened to be run from — a fleet file describes paths
    // relative to itself, and that is what makes `--config` from another
    // directory behave the way anyone would expect.
    return { ...parseFleet(parsed, dirname(path)), path };
  }

  throw new ConfigError(
    `no fleet config found (looked for ${FLEET_FILENAMES.join(', ')} in ${cwd})`,
  );
}
