import { acpCommandFor, isUsable, runtimeById, type RuntimeStatus } from '@quintal/shared';

import type { AgentConfig } from './config.js';
import { probeModels } from './models.js';
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
  /**
   * The name the office knows this machine by.
   *
   * Not the OS hostname. On macOS `os.hostname()` returns the name the local
   * network handed out, so the same computer answers to `Joaos-MacBook-Pro-2`
   * on one network and `Joaos-MBP-2.home` on another — and reporting under the
   * drifting one makes a second machine appear in the office beside the real
   * registration, with the fleet still assigned to the first.
   *
   * Undefined when the fleet came from a local file rather than the office;
   * there is no registration to report under, so the hostname is all there is.
   */
  hostLabel?: string;
}

interface Entry {
  runner: AgentRunner;
  colour: number;
  config: AgentConfig;
  startError?: string;
}

/**
 * Would these two configs produce the same running agent?
 *
 * Name is the identity; everything here is what cannot be changed without a
 * restart. Deliberately ignores `key`/`hostToken` — a rotated credential is a
 * reconnect concern, not a reason to drop a session mid-turn.
 */
/**
 * Is this the same agent, configured the same way?
 *
 * Not just "launched the same way", which is what this used to ask. An agent
 * learns what it is — its owner's instructions, its description — from
 * `agent:ready`, at connect. So a running agent whose profile was edited keeps
 * the old one until something restarts it, and comparing only the spawn
 * arguments meant nothing ever did.
 *
 * That had a second symptom which looked unrelated: disabling an agent and
 * enabling it again inside one poll interval left the fleet list unchanged, so
 * reconcile saw the same launch and let it keep running. The obvious way to
 * apply an edit — toggle it off and on — was therefore also the way to appear
 * to do nothing.
 */
export function sameAgent(a: AgentConfig, b: AgentConfig): boolean {
  return (
    a.cwd === b.cwd &&
    a.url === b.url &&
    a.mapId === b.mapId &&
    a.command.join(' ') === b.command.join(' ') &&
    a.profile === b.profile &&
    (a.modelId ?? '') === (b.modelId ?? '')
  );
}

export class Supervisor {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly agents: AgentConfig[],
    private readonly options: SupervisorOptions = {},
  ) {
    for (const [index, config] of agents.entries()) this.#add(config, index);
  }

  #add(config: AgentConfig, index: number): void {
    const runner = new AgentRunner(config, this.options.logDir);
    const colour = COLOURS[index % COLOURS.length] ?? 36;
    runner.on('log', (level, message) => this.#write(config.name, colour, level, message));
    this.#entries.set(config.name, { runner, colour, config });
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
      const host = {
        label: this.options.hostLabel ?? hostLabel(),
        reposDir: this.options.reposDir ?? '',
      };
      const runtimes = await detectRuntimes();
      // Say what the machine has now; what each runtime offers takes longer.
      live[0]?.reportHost({ ...host, runtimes });
      for (const runner of live.slice(1)) runner.reportHost(host);

      // Then ask each usable runtime which models it offers, and report again.
      // A separate, later report rather than one slow one: the settings page
      // shows "ready" within a second and gains the model list when it
      // arrives, which beats showing nothing until every runtime has been
      // spawned and closed.
      const withModels = await Promise.all(
        runtimes.map(async (status): Promise<RuntimeStatus> => {
          if (!isUsable(status)) return status;
          const spec = runtimeById(status.id);
          const command = spec ? acpCommandFor(spec) : null;
          if (!command) return status;
          return { ...status, models: await probeModels(command) };
        }),
      );
      const stillLive = runners.find((runner) => runner.connected);
      stillLive?.reportHost({ ...host, runtimes: withModels });
    } catch {
      // Reporting is bookkeeping. Never let it take a working fleet down.
    }
  }

  /**
   * Bring the running fleet in line with a new list.
   *
   * The office is the source of truth when it defines the fleet, so this is
   * reconciliation rather than a restart: agents that are already up and
   * unchanged are left alone, because tearing down a working agent mid-turn to
   * apply an unrelated change is a worse outcome than a slightly stale fleet.
   *
   * Only *added* and *removed* agents are acted on. An agent whose repo or
   * runtime changed is treated as removed-and-added, since neither can be
   * changed on a live ACP session.
   */
  async reconcile(next: AgentConfig[]): Promise<{ added: string[]; removed: string[] }> {
    const wanted = new Map(next.map((config) => [config.name, config]));
    const added: string[] = [];
    const removed: string[] = [];

    for (const [name, entry] of [...this.#entries]) {
      const config = wanted.get(name);
      if (config && sameAgent(config, entry.config)) continue;

      await entry.runner.stop().catch(() => {});
      this.#entries.delete(name);
      removed.push(name);
    }

    for (const config of next) {
      if (this.#entries.has(config.name)) continue;
      this.#add(config, this.#entries.size);
      added.push(config.name);
    }

    const fresh = added
      .map((name) => this.#entries.get(name))
      .filter((entry): entry is Entry => entry !== undefined);

    await Promise.allSettled(
      fresh.map(async (entry) => {
        try {
          await entry.runner.start();
        } catch (error: unknown) {
          entry.startError = error instanceof Error ? error.message : String(error);
          this.#write(entry.runner.name, entry.colour, 'error', `failed to start: ${entry.startError}`);
        }
      }),
    );
    await this.#reportHost(fresh.map((entry) => entry.runner));

    return { added, removed };
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
