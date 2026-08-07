import type { AgentConfig } from './config.js';
import { AgentRunner, type RunnerState } from './runner/AgentRunner.js';
import { detectRuntimes, hostLabel } from './runtimes.js';

/**
 * Runs a fleet.
 *
 * The one rule that shapes this file: **agents are independent**. One agent
 * failing to start, crashing, or losing its connection must not touch the
 * others. A fleet where a bad `cwd` in entry three takes down the two working
 * agents is worse than no fleet mode at all.
 */

const COLOURS = [36, 32, 35, 33, 34, 31, 96, 92] as const;

export interface SupervisorOptions {
  logDir?: string;
  /** Write logs without ANSI colour — for pipes and CI. */
  plain?: boolean;
  /** Where this machine keeps repositories, reported to the office. */
  reposDir?: string;
}

interface Entry {
  runner: AgentRunner;
  colour: number;
  startError?: string;
}

export class Supervisor {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly agents: AgentConfig[],
    private readonly options: SupervisorOptions = {},
  ) {
    for (const [index, config] of agents.entries()) {
      const runner = new AgentRunner(config, options.logDir);
      const colour = COLOURS[index % COLOURS.length] ?? 36;
      runner.on('log', (level, message) => this.#write(config.name, colour, level, message));
      this.#entries.set(config.name, { runner, colour });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Boot everyone, concurrently, tolerating individual failures.
   *
   * `allSettled` rather than `all`: two working agents and one misconfigured
   * one is a useful outcome, and the person watching gets told exactly which
   * one failed and why.
   */
  async up(only?: string): Promise<{ started: number; failed: number }> {
    const targets = only
      ? [...this.#entries.entries()].filter(([name]) => name === only)
      : [...this.#entries.entries()];

    if (only && targets.length === 0) {
      throw new Error(`no agent named "${only}" in the fleet`);
    }

    const results = await Promise.allSettled(
      targets.map(async ([name, entry]) => {
        try {
          await entry.runner.start();
        } catch (error: unknown) {
          entry.startError = error instanceof Error ? error.message : String(error);
          this.#write(name, entry.colour, 'error', `failed to start: ${entry.startError}`);
          throw error;
        }
      }),
    );

    const failed = results.filter((result) => result.status === 'rejected').length;
    await this.#reportHost(targets.map(([, entry]) => entry.runner));
    return { started: results.length - failed, failed };
  }

  /**
   * Tell the office what this machine can run.
   *
   * Scanned once and shared, not once per agent: which CLIs are on PATH is a
   * fact about the laptop, and eight agents each shelling out to `which` eight
   * times would be the same answer at eight times the cost. Only the first
   * connected agent carries the list — the rest report the machine and their
   * own workspace, and an omitted list deliberately leaves the stored scan
   * alone rather than blanking it.
   *
   * Best-effort throughout: a fleet that works but hasn't told the settings
   * page about itself is far better than a fleet that refuses to boot because
   * `which` misbehaved.
   */
  async #reportHost(runners: AgentRunner[]): Promise<void> {
    const live = runners.filter((runner) => runner.connected);
    if (live.length === 0) return;

    try {
      const host = { label: hostLabel(), reposDir: this.options.reposDir ?? '' };
      const runtimes = await detectRuntimes();
      live[0]?.reportHost({ ...host, runtimes });
      for (const runner of live.slice(1)) runner.reportHost(host);
    } catch {
      // Reporting is bookkeeping. Never let it take a working fleet down.
    }
  }

  async down(): Promise<void> {
    await Promise.allSettled(
      [...this.#entries.values()].map((entry) => entry.runner.stop()),
    );
  }

  /** Snapshot for `quintal-acp status`. */
  table(): Array<{
    name: string;
    harness: string;
    state: RunnerState;
    connected: boolean;
    status: string;
  }> {
    return [...this.#entries.entries()].map(([name, entry]) => ({
      name,
      harness: entry.runner.harness,
      state: entry.runner.state,
      connected: entry.runner.connected,
      status: entry.startError ?? entry.runner.statusLine,
    }));
  }

  #write(name: string, colour: number, level: 'info' | 'warn' | 'error', message: string): void {
    const time = new Date().toISOString().slice(11, 19);
    const label = name.padEnd(12).slice(0, 12);
    const marker = level === 'error' ? '✖' : level === 'warn' ? '!' : '·';

    if (this.options.plain === true) {
      process.stdout.write(`${time} ${label} ${marker} ${message}\n`);
      return;
    }

    process.stdout.write(
      `[90m${time}[0m [${colour}m${label}[0m ${marker} ${message}\n`,
    );
  }
}
