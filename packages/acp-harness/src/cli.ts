#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';

import {
  ConfigError,
  defaultCommandFor,
  defaultReposDir,
  expandHome,
  isHarness,
  loadFleet,
  splitCommand,
  type AgentConfig,
} from './config.js';
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

  quintal-acp up [name]        boot the fleet from quintal.fleet.json (or one agent)
  quintal-acp status           show the fleet's connection and status lines
  quintal-acp --key <KEY> --agent <harness> --cwd <dir> [--url <url>]
                               run a single agent without a config file

Options
  --config <path>   fleet file (default: quintal.fleet.json, .quintal/fleet.json)
  --url <url>       office URL (default: http://localhost:3000)
  --map <mapId>     map to join (default: hq)
  --cmd "<command>" explicit ACP command; required for --agent custom
  --repo <name>     workspace by name, resolved under --repos-dir
  --repos-dir <dir> where your projects live (default: ~/projects)
  --log-dir <dir>   write every prompt and response to <dir>/<agent>.jsonl
  --plain           no colour in logs
  -h, --help

Harnesses: claude-code, goose, codex, custom
Protocol:  docs/GATEWAY.md — anything speaking it is a valid agent.
`;

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

  if (!cwdFlag && !repoFlag) {
    throw new ConfigError(
      '--cwd or --repo is required: an agent needs an explicit workspace, and code context always comes from there',
    );
  }

  const workspace = repoFlag
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

  if (command === 'single') {
    agents = [singleAgentFrom(flags, cwd)];
  } else if (command === 'up' || command === 'status') {
    const fleet = loadFleet(stringFlag(flags, 'config'), cwd);
    agents = fleet.agents;
    only = positional[1];
    if (command === 'up' && only === undefined) {
      process.stdout.write(`fleet: ${agents.length} agent(s) from ${fleet.path}\n`);
    }
  } else {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  const supervisor = new Supervisor(agents, { logDir, plain });

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

  if (started === 0) {
    await supervisor.down();
    process.exitCode = 1;
    return;
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
