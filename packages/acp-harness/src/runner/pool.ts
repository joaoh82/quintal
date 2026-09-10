import type { Worker } from './worker.js';

/**
 * The runtime processes one agent answers with.
 *
 * Sized by the agent's parallelism but filled lazily: an agent that answers
 * one conversation at a time costs one process, however high its ceiling,
 * and the second Claude Code is only spawned the moment two conversations
 * actually want answering at once. Spawning is seconds of work, so a turn
 * that opens a worker pays for it — once, and only under load.
 *
 * Claiming prefers the worker that already holds a session for the scope,
 * so a conversation stays with its context whenever that worker is free. When
 * it is busy with something else, any idle worker takes the turn in a fresh
 * session; the runner's history window carries the conversation across, and
 * an answer now beats the same answer after somebody else's review.
 */
export class Pool {
  readonly #workers: Worker[] = [];

  constructor(
    readonly max: number,
    private readonly make: (index: number) => Worker,
  ) {}

  get size(): number {
    return this.#workers.length;
  }

  workers(): readonly Worker[] {
    return this.#workers;
  }

  /** Workers whose process is up. None means the agent is offline. */
  running(): Worker[] {
    return this.#workers.filter((worker) => worker.running);
  }

  /** Workers not given up on. */
  live(): Worker[] {
    return this.#workers.filter((worker) => !worker.dead);
  }

  /** The first worker, made if there is none — what `start()` boots. */
  first(): Worker {
    return this.#workers[0] ?? this.#spawn();
  }

  /**
   * An idle worker for a scope, or null when every one is busy and the pool
   * is full. The caller marks it busy at once — in the same tick — so two
   * turns cannot claim the same worker.
   *
   * A worker given up on does not hold its slot: the ceiling is on workers
   * that can work, so a crash does not quietly lower the agent's parallelism
   * for the rest of its life. But once *every* worker is dead the pool stays
   * that way — a runtime that dies twice on this machine will die a third
   * time, and spawning it per message would be a crash loop with a chat
   * transcript.
   */
  claim(scope: string): Worker | null {
    const idle = this.#workers.filter((worker) => worker.idle);
    const withSession = idle.find((worker) => worker.hasSession(scope));
    if (withSession) return withSession;
    const any = idle[0];
    if (any) return any;
    const live = this.live();
    if (this.#workers.length > 0 && live.length === 0) return null;
    return live.length < this.max ? this.#spawn() : null;
  }

  /** An idle worker to warm a session on, preferring one that is already up. */
  idle(scope: string): Worker | null {
    const idle = this.#workers.filter((worker) => worker.idle);
    return (
      idle.find((worker) => worker.hasSession(scope)) ??
      idle.find((worker) => worker.running) ??
      idle[0] ??
      null
    );
  }

  /**
   * A new worker — in a dead one's slot when there is one, so a runtime that
   * flaps while the others carry on does not grow the pool without bound,
   * and the dead worker's bridge is closed rather than left listening.
   */
  #spawn(): Worker {
    const slot = this.#workers.findIndex((worker) => worker.dead);
    const index = slot === -1 ? this.#workers.length : slot;
    const worker = this.make(index);
    if (slot === -1) this.#workers.push(worker);
    else {
      void this.#workers[slot]?.stop();
      this.#workers[slot] = worker;
    }
    // Started here so it is on its way before anybody awaits it; the failure,
    // if any, reaches whoever does.
    worker.ready().catch(() => {});
    return worker;
  }
}
