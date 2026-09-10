import type * as schema from '@agentclientprotocol/sdk';

import { AgentProcess } from '../acp/agent-process.js';
import type { AgentConfig } from '../config.js';
import type { Gateway } from '../gateway/client.js';
import { startBridge, type BridgeHandle, type BridgeHooks } from '../mcp/bridge.js';
import { pickModel } from '../models.js';
import { mcpServerArgs } from './mcp-args.js';
import { isThrowawayScope } from './scopes.js';
import { SessionStore } from './sessions.js';

/**
 * One runtime process, and what it holds.
 *
 * An agent that answers several conversations at once runs several of these
 * — a pool, sized by its parallelism — because an ACP agent runs one prompt
 * at a time and nothing in the protocol promises otherwise. Each worker is a
 * whole Claude Code, Codex or Goose of its own: its own sessions (one per
 * scope, LRU-capped), its own record of which sessions have been told the
 * standing instructions, and its own loopback bridge so a tool call can be
 * traced back to the turn that made it.
 *
 * What a worker does *not* hold: the queues, the history, the turn loop.
 * Those belong to the runner, which is the one thing that sees every
 * conversation at once.
 */

/** A turn in flight: one scope, one worker, one prompt. */
export interface Turn {
  id: number;
  scope: string;
  worker: Worker;
  /** The ACP session, once it exists. Updates are routed to the turn by it. */
  sessionId: string | null;
  /** Streamed text, assembled before it is spoken. */
  buffer: string;
  /** The status line this turn last set — thinking, a tool, waiting. */
  status: string;
  /** Ordering only: which turn's status the nameplate shows. */
  statusAt: number;
  /**
   * Whether `session/prompt` was sent. A failure before that point lost
   * nothing and may be retried; one after it may have done half the work.
   */
  prompted: boolean;
  /**
   * The owner said stop before there was a session to cancel. Checked the
   * moment one exists, so `!cancel` typed during a slow handshake is not
   * a no-op that lets the turn run to the end anyway.
   */
  cancelled: boolean;
  /**
   * What core memory looked like when this turn primed its session — see
   * `AgentRunner.#memoryGeneration`. A write that lands while the priming
   * turn runs leaves the session primed with the old memory, and this is
   * how the runner knows to prime it again.
   */
  memoryGeneration: number;
}

/** The runtime did not offer the model the owner chose. */
export class ModelRefusedError extends Error {
  constructor(
    readonly wanted: string,
    readonly harness: string,
  ) {
    super(`model "${wanted}" is not offered by ${harness}`);
    this.name = 'ModelRefusedError';
  }
}

export interface WorkerOptions {
  index: number;
  config: AgentConfig;
  gateway: Gateway;
  /** Tool calls that need the turn: bound by the runner, per worker. */
  hooks: BridgeHooks;
  onUpdate: (worker: Worker, params: schema.SessionNotification) => void;
  onPermission: (
    worker: Worker,
    params: schema.RequestPermissionRequest,
  ) => Promise<schema.RequestPermissionResponse>;
  /** The process died on its own. Not called for a `stop()`. */
  onExit: (worker: Worker, code: number | null) => void;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class Worker {
  readonly index: number;
  readonly sessions: SessionStore;
  /**
   * Scopes whose session exists but has not been told anything yet.
   *
   * Separate from the session book because it tracks what the *model* has
   * been told, not what is allocated: a session can be created long before
   * anybody speaks to it, and pre-warming relies on exactly that gap.
   */
  readonly unprimed = new Set<string>();
  /**
   * Session creations still in flight, by scope. Two callers that both find
   * no session must not both make one — and since warming is not awaited,
   * there is usually a creation in flight exactly when the first message
   * tends to arrive.
   */
  readonly #creating = new Map<string, Promise<string>>();

  /** The turn this worker is running, or null when idle. Set by the runner. */
  turn: Turn | null = null;
  /** Crashes survived. The second one is the one worth telling a human about. */
  restarts = 0;
  /** Given up on: it will not be claimed again and counts against the pool. */
  dead = false;

  #process: AgentProcess | null = null;
  #bridge: BridgeHandle | null = null;
  #starting: Promise<void> | null = null;
  #exited: Promise<never> = new Promise(() => {});
  #stopping = false;

  constructor(private readonly options: WorkerOptions) {
    this.index = options.index;
    this.sessions = new SessionStore({
      onEvict: (record, reason) => {
        this.#log('info', `session for "${record.scope}" ended (${reason})`);
        // ACP has no way to close a session, so the nearest thing: cancel
        // whatever it might be doing. Left alone, an evicted session is a
        // context the agent keeps warm for nobody.
        this.#process?.cancel(record.sessionId);
      },
    });
  }

  get running(): boolean {
    return this.#process?.running === true;
  }

  /** Free to take a turn. A worker still starting counts: the turn waits on it. */
  get idle(): boolean {
    return this.turn === null && !this.dead;
  }

  hasSession(scope: string): boolean {
    return this.sessions.has(scope);
  }

  /**
   * Started, or joining a start already under way. A worker that fails to
   * start is dead: the turn that was waiting on it fails once and is
   * retried elsewhere, and the pool does not try to spawn it again.
   */
  ready(): Promise<void> {
    if (!this.#starting) {
      this.#starting = this.#start().catch((error: unknown) => {
        this.dead = true;
        throw error;
      });
    }
    return this.#starting;
  }

  /** After a crash: the same bridge, a fresh process. */
  restart(): Promise<void> {
    this.#starting = this.#start();
    return this.#starting;
  }

  async #start(): Promise<void> {
    if (!this.#bridge) {
      this.#bridge = await startBridge(
        this.options.gateway,
        (tool) => this.#log('info', `tool: ${tool}`),
        this.options.hooks,
      );
    }
    const bridge = this.#bridge;

    let exited: (error: Error) => void = () => {};
    this.#exited = new Promise<never>((_, reject) => {
      exited = reject;
    });
    // Nobody may ever await it: it exists to be raced against a prompt.
    this.#exited.catch(() => {});

    const proc = new AgentProcess({
      command: this.options.config.command,
      cwd: this.options.config.cwd,
      onUpdate: (params) => this.options.onUpdate(this, params),
      onPermission: (params) => this.options.onPermission(this, params),
      onStderr: (line) => {
        this.#log('warn', `[${this.options.config.harness}] ${line}`);
        if (line.includes('cannot be launched inside another')) {
          this.#log(
            'error',
            'this harness refuses to run nested — boot the fleet from a plain shell, ' +
              'or use the default claude-code command (see COMPAT.md)',
          );
        }
      },
      onExit: (code) => {
        exited(new Error(`agent process exited (${code ?? 'signal'})`));
        // Every session belonged to the process that just went away.
        this.sessions.clear();
        this.unprimed.clear();
        this.#creating.clear();
        if (this.#stopping) return;
        this.options.onExit(this, code);
      },
      env: {
        QUINTAL_BRIDGE_URL: bridge.url,
        QUINTAL_BRIDGE_TOKEN: bridge.token,
      },
    });

    const info = await proc.start();
    this.#process = proc;
    this.sessions.clear();
    this.unprimed.clear();
    this.#creating.clear();
    this.#log(
      'info',
      `${info.agentInfo?.name ?? this.options.config.harness} ready (ACP v${String(info.protocolVersion)})`,
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#process?.stop();
    this.#process = null;
    const bridge = this.#bridge;
    this.#bridge = null;
    await bridge?.close();
  }

  /** The ACP session for a scope, creating one if there is none. */
  async sessionFor(scope: string): Promise<string> {
    const existing = this.sessions.get(scope);
    if (existing) return existing.sessionId;

    const inflight = this.#creating.get(scope);
    if (inflight) return inflight;

    const creation = this.#createSession(scope);
    this.#creating.set(scope, creation);
    try {
      return await creation;
    } finally {
      this.#creating.delete(scope);
    }
  }

  /**
   * Creation is the expensive half and none of it is model work: the agent
   * CLI spawns our MCP server as a subprocess and completes a handshake with
   * it. It deliberately does **not** send the system prompt — that rides
   * along with the first real turn, so the first message costs one turn
   * rather than two, and a session nobody talks to costs nothing.
   */
  async #createSession(scope: string): Promise<string> {
    const proc = this.#process;
    const bridge = this.#bridge;
    if (!proc || !bridge) throw new Error('agent is not running');

    // A banter session gets no tools: the one turn it lives for is a line
    // to a colleague, and a model with `say` and `move_to` in reach while
    // being asked for a joke is a model that can wander off or mention
    // somebody mid-joke. Cheaper, too — no MCP subprocess, no handshake.
    // The same for a `!forget` put to the model: it picks a number.
    const tools = isThrowawayScope(scope)
      ? []
      : [
          {
            name: 'quintal-tools',
            command: process.execPath,
            args: mcpServerArgs(),
            env: [
              { name: 'QUINTAL_BRIDGE_URL', value: bridge.url },
              { name: 'QUINTAL_BRIDGE_TOKEN', value: bridge.token },
            ],
          },
        ];
    const created = await proc.newSession({
      cwd: this.options.config.cwd,
      mcpServers: tools,
    } as schema.NewSessionRequest);

    await this.#applyModel(proc, created);

    this.sessions.put(scope, created.sessionId);
    // A fresh session has been told nothing yet.
    this.unprimed.add(scope);
    this.#log('info', `new session for "${scope}" (${this.sessions.size} live)`);

    return created.sessionId;
  }

  /**
   * Run on the model the owner chose, or do not run.
   *
   * The model is picked from what the agent advertised at `session/new`, and
   * set with `session/set_config_option` — never a command-line flag, so a
   * value from the office can never become argv on this machine. An agent
   * that was not offered the model its card names refuses the session rather
   * than answering on whatever the default is.
   */
  async #applyModel(proc: AgentProcess, created: schema.NewSessionResponse): Promise<void> {
    const wanted = this.options.config.modelId;
    if (!wanted) return;

    const choice = pickModel((created as { configOptions?: unknown }).configOptions, wanted);
    if (!choice) {
      // The session that was opened to find this out is not kept; nothing
      // will be said in it.
      proc.cancel(created.sessionId);
      throw new ModelRefusedError(wanted, this.options.config.harness);
    }

    await proc.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: choice.configId,
      type: 'id',
      value: choice.value,
    } as schema.SetSessionConfigOptionRequest);
    this.#log('info', `model set to ${wanted}`);
  }

  /**
   * One prompt. Rejects if the process dies underneath it, rather than
   * leaving the turn waiting on a reply from nobody.
   */
  prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    const proc = this.#process;
    if (!proc) return Promise.reject(new Error('agent is not running'));
    return Promise.race([proc.prompt(params), this.#exited]);
  }

  cancel(sessionId: string): void {
    this.#process?.cancel(sessionId);
  }

  /** Forget a scope's session, so the next turn there starts fresh. */
  dropSession(scope: string, reason: 'lru' | 'rotate' = 'rotate'): boolean {
    const dropped = this.sessions.drop(scope, reason);
    this.unprimed.delete(scope);
    return dropped !== undefined;
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    // The first worker is the agent as far as the log reads; the others say
    // which one they are, because "new session" three times in a row is a
    // puzzle without it.
    this.options.log(level, this.index === 0 ? message : `[worker ${this.index}] ${message}`);
  }
}
