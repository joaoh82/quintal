import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { RUNTIMES, acpCommandFor, runtimeById } from '@quintal/shared';

/**
 * How a fleet is declared.
 *
 * The primary user runs 3–10 agents across mixed harnesses, so the file format
 * is the main interface and the single-agent CLI flags are the special case,
 * not the other way round.
 */

/** `repo: "*"` — root at the repos directory itself rather than one checkout. */
export const ALL_REPOS = '*';

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
   * Empty when this agent was defined in the office: there the credential is
   * the machine's `hostToken` plus `agentId`, because a key the office could
   * hand out would be a key the office had to store recoverably.
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
   * The agent's workspace. Mandatory, always: code context comes from here and
   * never from Quintal, so an agent without one has no idea what it is working
   * on — see `docs/GATEWAY.md` and the safety rails in the README.
   */
  cwd: string;
  /**
   * True when `cwd` is the whole repos directory rather than one checkout.
   *
   * Worth tracking separately from the path because it is the difference
   * between "can edit this project" and "can edit every project I have", and
   * that difference should be visible in the office rather than inferred by
   * comparing two strings.
   */
  rootedAtReposDir: boolean;
  url: string;
  mapId: string;
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
 * `cwd` stays mandatory — an agent must never inherit whatever directory the
 * CLI happened to start in — but spelling out an absolute path per agent is
 * tedious when they all live under one root. Set `reposDir` once and each agent
 * can say `"repo": "api"` instead.
 *
 * Default follows the convention: `~/projects`, overridable per fleet or by
 * QUINTAL_REPOS_DIR.
 */
export const DEFAULT_REPOS_DIRNAME = 'projects';

export function defaultReposDir(): string {
  return process.env.QUINTAL_REPOS_DIR ?? join(homedir(), DEFAULT_REPOS_DIRNAME);
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
    const repo = typeof rawAgent.repo === 'string' ? rawAgent.repo.trim() : '';
    const rootedAtReposDir = repo === ALL_REPOS;
    const cwdRaw = rootedAtReposDir
      ? reposDir
      : repo.length > 0
        ? repo
        : requireString(rawAgent.cwd, 'cwd', name);
    const cwd = rootedAtReposDir
      ? reposDir
      : repo.length > 0
        ? resolve(reposDir, expandHome(repo))
        : isAbsolute(expandHome(cwdRaw))
          ? expandHome(cwdRaw)
          : resolve(baseDir, expandHome(cwdRaw));

    // Check it now, with the agent's name attached. Otherwise the failure is a
    // bare ENOENT from `spawn` several seconds later, after the office
    // connection is already open — and a relative cwd that resolved against the
    // wrong directory looks identical to a typo.
    assertDirectory(cwd, name, cwdRaw);

    return {
      name,
      key: resolveKey(rawAgent, name),
      harness: harnessName,
      command,
      cwd,
      rootedAtReposDir,
      url,
      mapId,
    } satisfies AgentConfig;
  });

  return { url, mapId, reposDir, agents };
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
