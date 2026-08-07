import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * How a fleet is declared.
 *
 * The primary user runs 3–10 agents across mixed harnesses, so the file format
 * is the main interface and the single-agent CLI flags are the special case,
 * not the other way round.
 */

/** Harnesses we know how to spawn without being told a command. */
export const KNOWN_HARNESSES = ['claude-code', 'goose', 'codex', 'custom'] as const;
export type Harness = (typeof KNOWN_HARNESSES)[number];

export function isHarness(value: string): value is Harness {
  return (KNOWN_HARNESSES as readonly string[]).includes(value);
}

export interface AgentConfig {
  name: string;
  /** Resolved at load time from `key` or `keyEnv`. Never written back to disk. */
  key: string;
  harness: Harness;
  /** Command line for the ACP agent. Required for `custom`. */
  command: string[];
  /**
   * The agent's workspace. Mandatory, always: code context comes from here and
   * never from Quintal, so an agent without one has no idea what it is working
   * on — see `docs/GATEWAY.md` and the safety rails in the README.
   */
  cwd: string;
  url: string;
  mapId: string;
}

export interface FleetConfig {
  url: string;
  mapId: string;
  agents: AgentConfig[];
}

interface RawAgent {
  name?: unknown;
  key?: unknown;
  keyEnv?: unknown;
  agent?: unknown;
  cmd?: unknown;
  cwd?: unknown;
}

interface RawFleet {
  url?: unknown;
  mapId?: unknown;
  agents?: unknown;
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
  switch (harness) {
    case 'claude-code':
      // Not `@zed-industries/claude-code-acp`: that package is deprecated in
      // favour of this one, and the old build refuses to start when it detects
      // it is inside another Claude Code session — which is exactly what
      // happens if you boot your fleet from a Claude Code terminal.
      return ['npx', '-y', '@agentclientprotocol/claude-agent-acp'];
    case 'goose':
      return ['goose', 'acp'];
    case 'codex':
      return ['npx', '-y', '@agentclientprotocol/codex-acp'];
    case 'custom':
      throw new ConfigError('agent "custom" requires an explicit cmd');
  }
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

    // Refusing to run without a cwd is a safety rail, not a convenience check:
    // an agent's code context comes from its working directory, and one that
    // defaults to wherever the CLI happened to be launched is an agent editing
    // a repository nobody chose.
    const cwdRaw = requireString(rawAgent.cwd, 'cwd', name);
    const cwd = isAbsolute(cwdRaw) ? cwdRaw : resolve(baseDir, cwdRaw);

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
      url,
      mapId,
    } satisfies AgentConfig;
  });

  return { url, mapId, agents };
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
