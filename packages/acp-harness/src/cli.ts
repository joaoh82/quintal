#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';

import {
  ALL_REPOS,
  ConfigError,
  defaultCommandFor,
  defaultReposDir,
  expandHome,
  findFleetFile,
  isHarness,
  loadFleet,
  splitCommand,
  type AgentConfig,
} from './config.js';
import {
  fetchFleet,
  type StoredHost,
  labelFor,
  readStoredHost,
  toAgentConfigs,
  writeStoredHost,
} from './host.js';
import { runMcpServer } from './mcp/server.js';
import { Supervisor } from './supervisor.js';

/**
 * `quintal-acp` — put your agents in the office.
 *
 * Fleet mode is the primary form because the primary user runs three to ten
 * agents across mixed harnesses. The single-agent flags exist for the first
 * five minutes and for CI.
 */

const USAGE = `quintal-acp — bridge ACP agents into a Quintal office

  quintal-acp login --token <qh_…>
                               remember this machine's host token, so the office
                               can define agents that boot here
  quintal-acp up [name]        boot the fleet — from quintal.fleet.json if there
                               is one, otherwise whatever the office assigns
  quintal-acp status           show the fleet's connection and status lines
  quintal-acp --key <KEY> --agent <harness> --cwd <dir> [--url <url>]
                               run a single agent without a config file

Options
  --config <path>   fleet file (default: quintal.fleet.json, .quintal/fleet.json)
  --url <url>       office URL (default: http://localhost:3000)
  --map <mapId>     map to join (default: hq)
  --cmd "<command>" explicit ACP command; required for --agent custom
  --repo <name>     workspace by name, resolved under --repos-dir
  --all-repos       root at the repos directory itself, not one checkout
  --repos-dir <dir> where your projects live (default: ~/projects)
  --log-dir <dir>   write every prompt and response to <dir>/<agent>.jsonl
  --plain           no colour in logs
  -h, --help

Harnesses: claude-code, goose, codex, custom
Protocol:  docs/GATEWAY.md — anything speaking it is a valid agent.
`;

/** How often to ask the office whether the fleet changed. */
const FLEET_POLL_MS = 15_000;

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '-h' || arg === '--help') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Build a one-agent fleet from CLI flags. */
function singleAgentFrom(flags: Flags, cwd: string): AgentConfig {
  const key = stringFlag(flags, 'key') ?? process.env.AGENT_KEY;
  if (!key) throw new ConfigError('--key (or AGENT_KEY) is required');

  const harnessName = stringFlag(flags, 'agent') ?? 'custom';
  if (!isHarness(harnessName)) {
    throw new ConfigError(`unknown harness "${harnessName}"`);
  }

  const cmd = stringFlag(flags, 'cmd');
  const command = cmd ? splitCommand(cmd) : defaultCommandFor(harnessName);

  // The same rail as fleet mode: an agent without an explicit workspace is an
  // agent editing whatever directory the CLI happened to be launched from.
  const reposDir = stringFlag(flags, 'repos-dir')
    ? expandHome(String(stringFlag(flags, 'repos-dir')))
    : defaultReposDir();
  const repoFlag = stringFlag(flags, 'repo');
  const cwdFlag = stringFlag(flags, 'cwd');

  // `--all-repos`, not `--repo '*'`: an unquoted `*` is expanded by the shell
  // before the CLI ever sees it, and a flag whose meaning depends on getting
  // the quoting right through a task runner is a flag that will silently root
  // an agent at whatever file sorted first in the current directory.
  // `"repo": "*"` stays valid in the fleet file, where no shell is involved.
  const rootedAtReposDir = flags['all-repos'] === true || repoFlag === ALL_REPOS;

  if (!cwdFlag && !repoFlag && !rootedAtReposDir) {
    throw new ConfigError(
      '--cwd, --repo or --all-repos is required: an agent needs an explicit workspace, and code context always comes from there',
    );
  }

  const workspace = rootedAtReposDir
    ? reposDir
    : repoFlag
      ? resolve(reposDir, expandHome(repoFlag))
      : isAbsolute(expandHome(cwdFlag ?? ''))
        ? expandHome(cwdFlag ?? '')
        : resolve(cwd, expandHome(cwdFlag ?? ''));

  return {
    name: stringFlag(flags, 'name') ?? harnessName,
    key,
    harness: harnessName,
    command,
    cwd: workspace,
    rootedAtReposDir,
    url: stringFlag(flags, 'url') ?? 'http://localhost:3000',
    mapId: stringFlag(flags, 'map') ?? 'hq',
  };
}

function printStatus(supervisor: Supervisor): void {
  const rows = supervisor.table();
  const width = Math.max(4, ...rows.map((row) => row.name.length));

  process.stdout.write(
    `${'AGENT'.padEnd(width)}  ${'HARNESS'.padEnd(12)}  ${'STATE'.padEnd(10)}  STATUS\n`,
  );
  for (const row of rows) {
    const state = row.connected ? row.state : `${row.state} (offline)`;
    process.stdout.write(
      `${row.name.padEnd(width)}  ${row.harness.padEnd(12)}  ${state.padEnd(10)}  ${row.status || '—'}\n`,
    );
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  // Hidden subcommand: the MCP tool server the agent's harness spawns. Same
  // binary so there is exactly one thing to install.
  if (positional[0] === 'mcp-server') {
    await runMcpServer();
    return;
  }

  if (positional[0] === 'login') {
    const token = stringFlag(flags, 'token');
    if (!token) throw new ConfigError('login needs --token <qh_…> from /settings/agents');
    const path = writeStoredHost({
      token,
      url: stringFlag(flags, 'url') ?? 'http://localhost:3000',
      ...(stringFlag(flags, 'host') ? { label: String(stringFlag(flags, 'host')) } : {}),
      ...(stringFlag(flags, 'repos-dir')
        ? { reposDir: expandHome(String(stringFlag(flags, 'repos-dir'))) }
        : {}),
    });
    process.stdout.write(`saved to ${path} (owner-readable only)\n`);
    return;
  }

  if (flags.help === true) {
    process.stdout.write(USAGE);
    return;
  }

  const cwd = process.cwd();
  const command = positional[0] ?? (flags.key !== undefined ? 'single' : 'help');

  if (command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const logDir = stringFlag(flags, 'log-dir');
  const plain = flags.plain === true;

  let agents: AgentConfig[];
  let only: string | undefined;
  let reposDir = defaultReposDir();
  /** Set when the office is the source of truth, so we know to keep asking. */
  let officeFleet: { host: StoredHost; label: string; mapId: string } | null = null;

  if (command === 'single') {
    agents = [singleAgentFrom(flags, cwd)];
    const dir = stringFlag(flags, 'repos-dir');
    if (dir) reposDir = expandHome(dir);
  } else if (command === 'up' || command === 'status') {
    // A local fleet file wins. Somebody who wrote one meant it, and silently
    // preferring the office would make a checked-in config stop working the
    // moment a machine was registered.
    const stored = readStoredHost();
    const localFleet = stringFlag(flags, 'config') ?? findFleetFile(cwd);

    if (localFleet === null && stored !== null) {
      const label = stringFlag(flags, 'host') ?? labelFor(stored);
      reposDir = stringFlag(flags, 'repos-dir')
        ? expandHome(String(stringFlag(flags, 'repos-dir')))
        : (stored.reposDir ?? defaultReposDir());

      const mapId = stringFlag(flags, 'map') ?? 'hq';
      const fleet = await fetchFleet(stored, label);
      const built = toAgentConfigs(fleet, stored, reposDir, mapId);
      agents = built.agents;
      only = positional[1];
      officeFleet = { host: stored, label, mapId };

      for (const skip of built.skipped) {
        process.stderr.write(`skipping "${skip.name}": ${skip.why}\n`);
      }
      if (command === 'up' && only === undefined) {
        process.stdout.write(
          `fleet: ${agents.length} agent(s) assigned to "${label}" by ${fleet.host.owner}\n`,
        );
      }
    } else {
      const fleet = loadFleet(stringFlag(flags, 'config'), cwd);
      agents = fleet.agents;
      reposDir = fleet.reposDir;
      only = positional[1];
      if (command === 'up' && only === undefined) {
        process.stdout.write(`fleet: ${agents.length} agent(s) from ${fleet.path}\n`);
      }
    }
  } else {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const supervisor = new Supervisor(agents, { logDir, plain, reposDir });

  if (command === 'status') {
    // `status` on a fleet nobody is running can only report the config; the
    // live view is printed by the running `up` process on SIGINFO/SIGUSR2.
    printStatus(supervisor);
    return;
  }

  const { started, failed } = await supervisor.up(only);
  process.stdout.write(`\n${started} agent(s) in the office${failed > 0 ? `, ${failed} failed` : ''}\n\n`);
  printStatus(supervisor);
  process.stdout.write('\nCtrl-C to bring everyone home.\n\n');

  // Zero agents is a failure when you wrote a fleet file — you asked for
  // specific agents and got none. It is the *normal starting state* when the
  // office defines the fleet: you register the machine, leave this running, and
  // create the first agent in the UI. Exiting would make that impossible.
  if (started === 0 && officeFleet === null) {
    await supervisor.down();
    process.exitCode = 1;
    return;
  }
  if (started === 0) {
    process.stdout.write('nothing assigned to this machine yet — create an agent in the office\n');
  }

  // When the office defines the fleet, keep asking. Polling rather than a push:
  // the harness already holds one WebSocket per agent, and adding a control
  // channel the office can speak on would be exactly the remote-command
  // surface this design exists to avoid.
  if (officeFleet !== null && only === undefined) {
    const poll = setInterval(() => {
      void (async () => {
        try {
          const fleet = await fetchFleet(officeFleet.host, officeFleet.label);
          const built = toAgentConfigs(fleet, officeFleet.host, reposDir, officeFleet.mapId);
          const { added, removed } = await supervisor.reconcile(built.agents);
          for (const name of removed) process.stdout.write(`— ${name} left the fleet\n`);
          for (const name of added) process.stdout.write(`+ ${name} joined the fleet\n`);
        } catch {
          // A blip should not take the fleet down; the next tick tries again.
        }
      })();
    }, FLEET_POLL_MS);
    poll.unref();
  }

  // A running fleet answers SIGUSR2 with a status table — useful when the logs
  // have scrolled and you want to know who is still up.
  process.on('SIGUSR2', () => printStatus(supervisor));

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write('\nbringing the fleet home…\n');
    void supervisor.down().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`config: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`quintal-acp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
