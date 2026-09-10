import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import {
  AGENT_CHAT_INTERVAL_MS,
  AGENT_PARALLELISM_MAX,
  AGENT_PARALLELISM_MIN,
  channelLabel,
  emoteForStatus,
  isAddressed,
  parseAgentCommand,
  type RuntimeStatus,
  type AgentBanterEvent,
  type AgentChannelChatEvent,
  type AgentChatEvent,
  type AgentMentionEvent,
  type ChannelRef,
} from '@quintal/shared';

import { nestRoot, type AgentConfig } from '../config.js';
import { writeGuide } from '../nest.js';
import { GatewayClient, type Gateway } from '../gateway/client.js';
import { credentialFor } from '../credential.js';
import { basePrompt } from './base-prompt.js';
import {
  buildForgetPrompt,
  dropLines,
  dropNumbered,
  findForget,
  memoryLines,
  numbered,
  parseForgetAnswer,
  parseLineNumbers,
} from './forget.js';
import {
  MAX_BATCH,
  TOOL_HINT,
  buildBanterEnvelope,
  buildEnvelope,
  selectWindow,
  type Trigger,
} from './context.js';
import { isHarnessNotice, statusForTool, toBubbles, toPosts } from './outbound.js';
import { Pool } from './pool.js';
import {
  LOBBY_SCOPE,
  banterScope,
  channelIdOf,
  channelScope,
  forgetScope,
  isBanterScope,
  isForgetScope,
  isSpatialScope,
} from './scopes.js';
import { ModelRefusedError, Worker, type Turn } from './worker.js';

export { mcpServerArgs } from './mcp-args.js';
export { forgetLines } from './forget.js';

/**
 * One agent, alive in one office.
 *
 * This is where the plan's §2.9 rules actually live: a session per scope,
 * batched triggers, steer notes instead of interrupts, owner-only commands —
 * and, since parallelism, one prompt in flight *per conversation* rather than
 * per agent. A DM sent while the agent reviews a pull request in a channel
 * used to wait for the review, with nothing to show for it; now it gets its
 * own runtime process from the pool and is answered alongside.
 *
 * Everything else in the package is plumbing around this.
 */

export type RunnerState = 'starting' | 'connected' | 'working' | 'offline' | 'stopped';

export interface RunnerEvents {
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  state: (state: RunnerState) => void;
  /** A guide was written into the nest; whoever keeps its index should refresh it. */
  guide: (file: string) => void;
}

/**
 * How long an owner has to answer a tool-approval question before silence
 * denies it. Five minutes: the question now goes where the owner is, so this
 * is the time to read and type, not the time to notice.
 */
const PERMISSION_TIMEOUT_MS = 300_000;

/**
 * Gap between two lines we send. The office allows an agent one every
 * `AGENT_CHAT_INTERVAL_MS`; a little over, so a burst is paced rather than
 * refused and then lost.
 */
const SEND_INTERVAL_MS = AGENT_CHAT_INTERVAL_MS + 100;

/**
 * How close someone must be for an unaddressed remark to count as talking to
 * you. Roughly "standing at your desk" rather than "somewhere in the room".
 *
 * A fallback only: the office serves its own value in `agent:ready`, because an
 * owner who widens walk-up distance in settings expects agents to obey it.
 */
const WALK_UP_RADIUS_FALLBACK_TILES = 3;

/**
 * How many times a batch of messages is handed to a turn before its failure
 * is said out loud. Once more, and only when nothing was prompted: a session
 * that would not open or a runtime that died on start is usually a different
 * worker's problem to solve, and the second failure is worth a human's eyes.
 */
const MAX_ATTEMPTS = 2;

export class AgentRunner {
  readonly name: string;

  #gateway: Gateway;
  #pool: Pool | null = null;
  /** False when somebody handed us a gateway; we must not replace theirs. */
  readonly #ownsGateway: boolean;

  /** Pending triggers, per scope. Drained into one prompt per turn. */
  readonly #queues = new Map<string, Trigger[]>();
  /** Conversation history per scope, for the pushed window. */
  readonly #history = new Map<string, AgentChatEvent[]>();
  /** channel id -> what it is, from every channel line seen, for naming a scope. */
  readonly #channelRefs = new Map<string, ChannelRef>();
  /**
   * Set when the runtime did not offer the model the owner chose. A standing
   * state, not a moment: it holds the nameplate against the idle reset every
   * turn ends with, and stops each new message opening another session that
   * would only be refused again. Cleared by a restart with a different
   * launch, which is the only way the model changes.
   */
  #modelRefusal: string | null = null;
  /** Scopes already told about the refusal, so it is said once, not per message. */
  readonly #refusalSaid = new Set<string>();
  /** The balloon last asked for, so the same one is not sent twice. */
  #emoteLine = '';
  /** When the next line may leave: everything we say is paced through here. */
  #nextSendAt = 0;

  /** Turns in flight, by id. One per scope at most; as many as the pool allows. */
  readonly #turns = new Map<number, Turn>();
  /** The same turns, by ACP session, so an update finds the turn it belongs to. */
  readonly #turnBySession = new Map<string, Turn>();
  /** Scopes with a turn in flight. A scope's messages wait for its own turn, never another's. */
  readonly #inFlight = new Set<string>();
  /**
   * Scopes whose next prompt follows work that was in flight when the
   * messages arrived — per scope, because a note that says "this came while
   * you were working" is only true of the session that was working.
   */
  readonly #steerPending = new Set<string>();
  #turnSeq = 0;
  #statusSeq = 0;
  /**
   * Bumped whenever core memory changes under the live sessions. A turn that
   * primed its session remembers the generation it read; if the memory moved
   * while it ran, the session is primed with the old notes and is told again.
   */
  #memoryGeneration = 0;
  /** Said once: the queue is being refused because nothing can run it. */
  #saidOffline = false;

  #state: RunnerState = 'starting';
  #statusLine = '';
  /** What was last sent as status and where, so the same picture is not re-sent. */
  #statusKey = '';
  #stopping = false;
  #reconnectAttempts = 0;

  /**
   * Permission questions asked in chat, keyed by tool call id. Several may be
   * open at once — one per turn — so an answer that names the tool goes to
   * that one, and a bare "yes" to the oldest.
   */
  readonly #permissionWaiters = new Map<
    string,
    { toolName: string; resolve: (decision: PermissionDecision) => void }
  >();

  readonly #handlers: Partial<RunnerEvents> = {};

  /**
   * `gateway` is injectable so the runner can be tested at all.
   *
   * It defaults to a real client, so nothing outside tests passes one — but
   * without the seam, checking anything about how a turn is run means standing
   * up an office and a websocket, and the runner accordingly had no tests.
   */
  constructor(
    private readonly config: AgentConfig,
    private readonly logDir?: string,
    gateway?: Gateway,
  ) {
    this.name = config.name;
    this.#ownsGateway = gateway === undefined;
    this.#gateway =
      gateway ??
      new GatewayClient(config.url, credentialFor(config), config.mapId, config.workspaceId);
  }

  on<K extends keyof RunnerEvents>(event: K, handler: RunnerEvents[K]): void {
    this.#handlers[event] = handler;
  }

  get state(): RunnerState {
    return this.#state;
  }

  get statusLine(): string {
    return this.#statusLine;
  }

  get harness(): string {
    return this.config.harness;
  }

  get connected(): boolean {
    return this.#gateway.connected;
  }

  /** How many conversations this agent answers at once. */
  get parallelism(): number {
    return this.#pool?.max ?? this.#parallelism();
  }

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connectGateway();

    // The office has now said how many. The pool is sized once, here: a
    // running agent cannot change it, which is why the supervisor restarts
    // one whose number moved.
    this.#pool = new Pool(this.#parallelism(), (index) => this.#makeWorker(index));
    // The first worker is awaited: a fleet whose runtime cannot start should
    // say so at boot, not on the first message. The rest are spawned when
    // two conversations actually want answering at once.
    await this.#pool.first().ready();
    if (this.#pool.max > 1) {
      this.#log('info', `answering up to ${this.#pool.max} conversations at once`);
    }

    this.#setState('connected');
    this.#publishStatus();

    // Not awaited: the agent is connected and usable now, and a slow handshake
    // with its MCP server should hold nobody up. By the time somebody speaks,
    // the expensive half is usually already done.
    this.prewarm();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#setState('stopped');
    const pool = this.#pool;
    this.#pool = null;
    await Promise.allSettled((pool?.workers() ?? []).map((worker) => worker.stop()));
    await this.#gateway.leave().catch(() => {});
  }

  /**
   * The size of the pool: the fleet file or `--parallelism` when given —
   * the machine running the processes has the last word — else what the
   * office resolved for this agent in `agent:ready`, else one, which is
   * what an office that predates the setting means.
   */
  #parallelism(): number {
    const wanted = this.config.parallelism ?? this.#gateway.ready?.limits?.parallelism ?? 1;
    if (!Number.isFinite(wanted)) return 1;
    return Math.min(AGENT_PARALLELISM_MAX, Math.max(AGENT_PARALLELISM_MIN, Math.round(wanted)));
  }

  #makeWorker(index: number): Worker {
    // The hooks close over the worker so a tool call can be traced to the
    // turn that made it: `say` posts where that turn is, `set_status` lands
    // on that turn, `memory_set` tells every *other* session what moved.
    let worker: Worker;
    worker = new Worker({
      index,
      config: this.config,
      gateway: this.#gateway,
      hooks: {
        say: (text) => this.#sayNow(worker, text),
        setStatus: (status) => this.#statusFromTool(worker, status),
        memorySet: (slug, content, expectedHash) =>
          this.#memorySetFromTool(worker, slug, content, expectedHash),
      },
      onUpdate: (from, params) => this.#onAcpUpdate(from, params),
      onPermission: (from, params) => this.#onPermissionRequest(from, params),
      onExit: (from, code) => void this.#onWorkerExit(from, code),
      log: (level, message) => this.#log(level, message),
    });
    return worker;
  }

  async #connectGateway(): Promise<void> {
    this.#gateway.on('ready', (ready) => {
      this.#log(
        'info',
        `in the office as ${ready.name} (${ready.ownerName}'s), ${ready.zoneId ?? 'open floor'}`,
      );
    });
    this.#gateway.on('chat', (message) => this.#onChat(message, message.distance));
    this.#gateway.on('mention', (message) => this.#onMention(message));
    this.#gateway.on('channelChat', (message) => this.#onChannelChat(message));
    this.#gateway.on('banter', (event) => this.#onBanter(event));
    this.#gateway.on('error', (error) => {
      this.#log('warn', `office refused something: [${error.code}] ${error.message}`);
      if (error.message.toLowerCase().includes('revoked')) void this.stop();
    });
    this.#gateway.on('closed', (code) => {
      if (this.#stopping) return;
      this.#setState('offline');
      this.#log('warn', `office connection closed (${code})`);
      void this.#reconnect();
    });

    await this.#gateway.connect();
    this.#reconnectAttempts = 0;
  }

  /**
   * Reconnect with backoff, silently.
   *
   * The office does not need to hear about our network problems — announcing a
   * reconnection is exactly the kind of noise the anti-noise rules exist to
   * prevent. It goes in the harness log, where the owner can see it.
   */
  async #reconnect(): Promise<void> {
    if (this.#stopping) return;

    this.#reconnectAttempts += 1;
    const delay = Math.min(1000 * 2 ** (this.#reconnectAttempts - 1), 30_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.#stopping) return;

    try {
      // Only replace a client we made. An injected gateway cannot be rebuilt
      // from config — there is nothing here that knows how — and silently
      // swapping in a real one would turn a test into a network call.
      if (this.#ownsGateway) {
        this.#gateway = new GatewayClient(
          this.config.url,
          credentialFor(this.config),
          this.config.mapId,
          this.config.workspaceId,
        );
      }
      await this.#connectGateway();
      this.#settleState();
      // A new socket knows nothing: send the picture again, whatever it is.
      this.#statusKey = '';
      this.#publishStatus();
      this.#log('info', 'reconnected');
    } catch (error: unknown) {
      this.#log('warn', `reconnect failed: ${describe(error)}`);
      void this.#reconnect();
    }
  }

  /**
   * One quiet restart per worker on a crash.
   *
   * The office sees "offline" in the status line and nothing else — a crashed
   * agent announcing its own resurrection in chat is noise, and the second
   * failure is the one worth telling a human about. A turn that was running
   * on the worker fails on its own (its prompt rejects) and says so where it
   * was asked.
   */
  async #onWorkerExit(worker: Worker, code: number | null): Promise<void> {
    if (this.#stopping) return;
    // A worker that died on the way up was already given up on by `ready()`;
    // restarting it would leave a live process nothing will ever claim.
    if (worker.dead) return;
    this.#log('warn', `agent process exited (${code ?? 'signal'})`);
    this.#publishStatus();

    if (worker.restarts >= 1) {
      worker.dead = true;
      this.#log('error', 'agent crashed again — not restarting');
      this.#noteIfNothingLeft();
      return;
    }

    worker.restarts += 1;
    try {
      await worker.restart();
      this.#log('info', 'agent restarted');
    } catch (error: unknown) {
      worker.dead = true;
      this.#log('error', `restart failed: ${describe(error)}`);
      this.#noteIfNothingLeft();
    }
    this.#settleState();
    this.#publishStatus();
    this.#drain();
  }

  /**
   * The state, from what is true now: nothing left to run on is offline,
   * whatever else is happening; otherwise working while any turn runs, and
   * connected between turns. One place, so a turn ending cannot undo a
   * pool that just gave up.
   */
  #settleState(): void {
    const pool = this.#pool;
    if (pool !== null && pool.live().length === 0) this.#setState('offline');
    else this.#setState(this.#turns.size > 0 ? 'working' : 'connected');
  }

  /**
   * Nothing left to run turns on. Said once, aloud, and shown as offline —
   * and the queue is refused rather than kept, because a message that will
   * never be answered must not look like one that is waiting its turn.
   */
  #noteIfNothingLeft(): void {
    if ((this.#pool?.live().length ?? 0) > 0) return;
    this.#settleState();
    this.#publishStatus();
    if (!this.#saidOffline) {
      this.#saidOffline = true;
      // Paced like every other line: the office allows one every two
      // seconds, and this one tends to land right behind a turn's failure.
      this.#send(`I've stopped working — ${this.config.harness} keeps crashing.`, undefined);
    }
    this.#refuseQueued();
  }

  /** Tell every conversation with a message waiting that nothing will answer it. */
  #refuseQueued(): void {
    for (const [scope, queue] of this.#queues) {
      if (queue.length > 0 && !isBanterScope(scope)) {
        this.#speak(`I can't answer right now — ${this.config.harness} is not running for me.`, scope);
      }
    }
    this.#queues.clear();
    this.#steerPending.clear();
  }

  // --- inbound -------------------------------------------------------------

  #onChat(message: AgentChatEvent, distance: number | null): void {
    const scope = this.#scopeOf();
    this.#remember(scope, message);

    const ready = this.#gateway.ready;
    if (!ready) return;

    // Never answer yourself.
    if (message.fromUserId === ready.agentId) return;

    if (this.#handleOwnerCommand(message, scope)) return;

    // "@me yes" / "@me no" answers an outstanding permission question rather
    // than starting a turn about it.
    if (this.#answersPermission(message, ready)) return;

    // Other agents are context, not conversation. Two bots within earshot
    // acknowledging each other is the failure mode that ate Buzz's rooms, and
    // the only cure is refusing to start the loop.
    if (message.fromKind === 'agent' && !isAddressed(message.text, ready.name)) return;

    if (!this.#addressesMe(message, distance, ready.name)) return;

    this.#enqueue(scope, {
      fromUserId: message.fromUserId,
      fromName: message.fromName,
      fromKind: message.fromKind,
      text: message.text,
      distance,
      sentAt: message.sentAt,
    });
  }

  /**
   * Was this said *to me*?
   *
   * Earshot is not the same as being addressed. Without this test every agent
   * within twelve tiles wakes up for every human sentence — a fleet of eight
   * turns one question into eight model calls and eight replies, which is both
   * expensive and the exact stampede the anti-noise rules exist to prevent.
   * Prompt law alone cannot fix it: by the time the model decides to stay
   * silent, the turn has already been paid for.
   *
   * So: your name wakes you from anywhere. Naming somebody else means it isn't
   * for you. Otherwise it has to be close enough to be a walk-up — and if you
   * stand in a huddle of agents and speak without naming one, they all answer,
   * exactly as three people would.
   */
  #addressesMe(message: AgentChatEvent, distance: number | null, myName: string): boolean {
    if (isAddressed(message.text, myName)) return true;

    const others = this.#gateway
      .occupants()
      .filter((occupant) => occupant.kind === 'agent' && occupant.name !== myName);
    if (others.some((other) => isAddressed(message.text, other.name))) return false;

    const walkUp =
      this.#gateway.ready?.limits.walkUpRadiusTiles ?? WALK_UP_RADIUS_FALLBACK_TILES;
    return distance !== null && distance <= walkUp;
  }

  /**
   * Tell the office about this machine, and where this agent is rooted.
   *
   * The runtime list is optional and its absence is meaningful — see
   * `Supervisor.#reportHost`.
   */
  reportHost(host: { label: string; reposDir: string; runtimes?: RuntimeStatus[] }): void {
    this.#gateway.hostReport({
      ...host,
      workspacePath: this.config.cwd,
    });
  }

  /** A mention carries no distance: it reached us from anywhere on the map. */
  #onMention(message: AgentMentionEvent): void {
    this.#onChat({ ...message, distance: 0 } as AgentChatEvent, null);
  }

  /**
   * A line in a channel we are in.
   *
   * Every line is remembered, in the channel's own scope, so the window a
   * turn is given holds the conversation. Only a line that names us starts a
   * turn — the office decides that, not a distance, because a channel has no
   * distances. Everything else is the quiet an agent in a channel is
   * supposed to keep.
   */
  #onChannelChat(message: AgentChannelChatEvent): void {
    const scope = channelScope(message.channel.id);
    this.#channelRefs.set(message.channel.id, message.channel);
    const asChat: AgentChatEvent = {
      from: message.from,
      fromUserId: message.fromUserId,
      fromName: message.fromName,
      fromKind: message.fromKind,
      text: message.text,
      distance: 0,
      sentAt: message.sentAt,
    };
    this.#remember(scope, asChat);

    const ready = this.#gateway.ready;
    if (!ready) return;
    if (message.fromUserId === ready.agentId) return;
    if (this.#handleOwnerCommand(asChat, scope)) return;
    // The question was asked here, so the answer arrives here.
    if (this.#answersPermission(asChat, ready)) return;
    if (!message.mentioned) return;

    this.#enqueue(scope, {
      fromUserId: message.fromUserId,
      fromName: message.fromName,
      fromKind: message.fromKind,
      text: message.text,
      distance: null,
      channel: message.channel,
      sentAt: message.sentAt,
    });
  }

  /**
   * The office offers a moment with another idle agent.
   *
   * Taken only when there is genuinely nothing to do: a turn in flight or a
   * message waiting means somebody is owed an answer, and a joke told while
   * they wait is the wrong kind of memorable. The moment simply passes.
   */
  #onBanter(event: AgentBanterEvent): void {
    const waiting = [...this.#queues.values()].some((queue) => queue.length > 0);
    if (this.#turns.size > 0 || waiting) {
      this.#log('info', `banter with ${event.partner.name} skipped: busy`);
      return;
    }
    this.#enqueue(banterScope(event.partner.id), {
      fromUserId: event.partner.id,
      fromName: event.partner.name,
      fromKind: 'agent',
      text: event.line ?? '',
      distance: 1,
      sentAt: Date.now(),
      banter: { line: event.line, expiresAt: event.expiresAt },
    });
  }

  /** The channel or DM a scope is, or null for a spatial scope. */
  #channelOf(scope: string): ChannelRef | null {
    const id = channelIdOf(scope);
    if (id === null) return null;
    return (
      this.#gateway.channels().find((channel) => channel.id === id) ??
      this.#channelRefs.get(id) ??
      { id, kind: 'channel', name: id, slug: id }
    );
  }

  /**
   * `!cancel`, `!rotate`, `!shutdown` — owner only.
   *
   * Checked against `ownerUserId`, never the display name: names are editable,
   * so name matching would let anyone in the workspace shut down somebody
   * else's agent by renaming themselves.
   */
  #handleOwnerCommand(message: AgentChatEvent, scope: string): boolean {
    const parsed = parseAgentCommand(message.text);
    if (!parsed) return false;

    const ready = this.#gateway.ready;
    if (!ready) return true;

    if (message.fromUserId !== ready.ownerUserId) {
      this.#log('warn', `ignoring "!${parsed.name}" from ${message.fromName} (not the owner)`);
      return true;
    }

    // An untargeted command is for every agent that heard it — useful for
    // "everyone stop", ruinous by accident. `!shutdown @claude` stops one.
    if (parsed.target !== null && parsed.target !== ready.name.toLowerCase()) return true;

    // Swallow a typo rather than passing it to the model: the office would
    // otherwise pay for a turn to be told the message means nothing. The chat
    // box refuses to send these, so reaching here means another client.
    if (!parsed.known) {
      this.#log('warn', `unknown command "!${parsed.name}"`);
      return true;
    }

    switch (`!${parsed.name}`) {
      case '!cancel': {
        // The turn in the conversation the command was typed in; failing
        // that, every turn — "stop" said in the room means all of it. A
        // turn still opening its session is marked, and stops the moment
        // there is a session to stop.
        const here = [...this.#turns.values()].filter((turn) => turn.scope === scope);
        const targets = here.length > 0 ? here : [...this.#turns.values()];
        for (const turn of targets) {
          turn.cancelled = true;
          if (turn.sessionId) turn.worker.cancel(turn.sessionId);
        }
        this.#log(
          'info',
          targets.length === 0
            ? 'nothing to cancel'
            : `turn cancelled by owner (${targets.length === 1 ? 'one turn' : `${targets.length} turns`})`,
        );
        return true;
      }
      case '!rotate': {
        // The scope the command arrived in: `!rotate` in a channel rotates
        // the channel's session, not the one for wherever we are standing.
        // On every worker: a scope may have been answered from more than one.
        const dropped = (this.#pool?.workers() ?? []).filter((worker) =>
          worker.dropSession(scope, 'rotate'),
        ).length;
        this.#log('info', `rotated session for "${scope}"${dropped > 0 ? '' : ' (none live)'}`);
        // Rebuild it now, so the next message does not pay for the rotation.
        this.prewarm(scope);
        return true;
      }
      case '!remember': {
        if (parsed.body.length === 0) {
          this.#log('warn', '!remember needs something to remember');
          return true;
        }
        // Not awaited inline: a command handler that blocks would hold up the
        // chat loop for a round trip to the office.
        void this.#writeCoreMemory(parsed.body, scope);
        return true;
      }
      case '!forget': {
        if (parsed.body.length === 0) {
          this.#speak('Forget what? `!forget` takes the words to look for.', scope);
          return true;
        }
        void this.#forgetCoreMemory(parsed.body, scope);
        return true;
      }
      case '!memory': {
        void this.#recallCoreMemory(scope);
        return true;
      }
      case '!guide': {
        // The first word names the guide; the rest is what goes in it.
        const match = /^(\S+)\s+([\s\S]+)$/.exec(parsed.body);
        if (!match?.[1] || !match[2]?.trim()) {
          this.#speak(
            '`!guide <name> <what to do>` — the first word names the guide, the rest is the procedure.',
            scope,
          );
          return true;
        }
        void this.#writeGuide(match[1], match[2], scope);
        return true;
      }
      case '!shutdown': {
        this.#log('info', 'shutdown requested by owner');
        void this.stop().then(() => process.exit(0));
        return true;
      }
      default:
        // `known` is checked above, so this is only reachable if the catalogue
        // grew a verb nobody implemented here.
        this.#log('warn', `"!${parsed.name}" is advertised but not implemented`);
        return true;
    }
  }

  #enqueue(scope: string, trigger: Trigger): void {
    const queue = this.#queues.get(scope) ?? [];
    queue.push(trigger);
    this.#queues.set(scope, queue);
    void this.#drain();
  }

  // --- the turn loop -------------------------------------------------------

  /**
   * One prompt in flight per conversation; as many conversations as the
   * pool has workers.
   *
   * A scope's messages wait for that scope's own turn to finish and are then
   * delivered as a steer note — never as an interrupt, because cancelling a
   * running turn whenever somebody says something is how you get an agent
   * that never finishes anything. Messages for a *different* scope do not
   * wait at all: they take an idle worker, or open one, and run alongside.
   * When every worker is busy they stay queued and are picked up the moment
   * one is returned.
   */
  #drain(): void {
    const pool = this.#pool;
    if (!pool || this.#stopping) return;
    if (pool.live().length === 0) {
      this.#refuseQueued();
      return;
    }

    for (const [scope, queue] of this.#queues) {
      if (queue.length === 0) {
        this.#queues.delete(scope);
        continue;
      }
      if (this.#inFlight.has(scope)) continue;

      // Null only while every worker is busy and the pool is full; nothing
      // else in the loop can take one either, but a loop that stops early
      // is a loop somebody will one day be surprised by.
      const worker = pool.claim(scope);
      if (!worker) continue;

      const turn: Turn = {
        id: (this.#turnSeq += 1),
        scope,
        worker,
        sessionId: null,
        buffer: '',
        status: '',
        statusAt: 0,
        prompted: false,
        cancelled: false,
        memoryGeneration: this.#memoryGeneration,
      };
      // Claimed in the same tick: nothing else can take this worker now.
      worker.turn = turn;

      const triggers = queue.splice(0, MAX_BATCH);
      if (queue.length === 0) this.#queues.delete(scope);

      void this.#runTurnOn(turn, triggers);
    }
  }

  async #runTurnOn(turn: Turn, triggers: Trigger[]): Promise<void> {
    const { scope, worker } = turn;
    this.#inFlight.add(scope);
    this.#turns.set(turn.id, turn);
    const steer = this.#steerPending.delete(scope);
    let requeued = false;

    try {
      await worker.ready();
      await this.#runTurn(turn, triggers, steer);
    } catch (error: unknown) {
      requeued = this.#turnFailed(turn, triggers, steer, error);
    } finally {
      this.#turns.delete(turn.id);
      if (turn.sessionId !== null) this.#turnBySession.delete(sessionKey(worker, turn.sessionId));
      this.#inFlight.delete(scope);
      worker.turn = null;
      this.#settleState();
      this.#publishStatus();
      // Anything that arrived for this scope while it was working is a
      // steer, not a fresh ask. The messages put back after a failure are
      // neither: they are the same ask, tried again.
      if (!requeued && (this.#queues.get(scope)?.length ?? 0) > 0) {
        this.#steerPending.add(scope);
      }
      this.#drain();
    }
  }

  /**
   * A turn that did not complete. Never silently: the messages go back once
   * if nothing was prompted yet, and otherwise the failure is said where
   * the question was asked — silence would look exactly like being ignored,
   * which is the one thing a person waiting on an agent must never get.
   *
   * Returns whether the messages were put back.
   */
  #turnFailed(turn: Turn, triggers: Trigger[], steer: boolean, error: unknown): boolean {
    const { scope } = turn;
    // Being shut down is not a failure anybody needs telling about: the
    // supervisor restarts an agent whose settings changed, and "something
    // went wrong" in chat every time would be exactly that kind of noise.
    if (this.#stopping) return false;
    const reason = describe(error);
    this.#log('error', `turn failed: ${reason}`);

    // A joke that could not be told is nothing; nobody was waiting for it.
    if (isBanterScope(scope)) return false;
    // A `!forget` the model was asked about: the owner is waiting, elsewhere.
    if (isForgetScope(scope)) {
      const forget = triggers[0]?.forget;
      if (forget) this.#speak('I could not change my memory, so that is still in there.', forget.scope);
      return false;
    }
    // Stopped on purpose: the owner already knows.
    if (turn.cancelled) return false;

    const attempt = Math.max(0, ...triggers.map((trigger) => trigger.attempt ?? 0)) + 1;
    if (!turn.prompted && this.#modelRefusal === null && attempt < MAX_ATTEMPTS) {
      const queue = this.#queues.get(scope) ?? [];
      this.#queues.set(scope, [
        ...triggers.map((trigger) => ({ ...trigger, attempt })),
        ...queue,
      ]);
      // Still the same messages that arrived mid-turn, if they did.
      if (steer) this.#steerPending.add(scope);
      this.#log('warn', `trying "${scope}" again`);
      return true;
    }

    if (this.#modelRefusal !== null) {
      // Once per conversation: the nameplate already says it, and a person
      // who asks twice does not need telling twice.
      if (this.#refusalSaid.has(scope)) return false;
      this.#refusalSaid.add(scope);
      this.#speak(
        `I can't answer here — ${this.#modelRefusal}. My owner needs to pick a model ${this.config.harness} offers.`,
        scope,
      );
      return false;
    }

    this.#speak(`Something went wrong while I was answering (${reason}).`, scope);
    return false;
  }

  async #runTurn(turn: Turn, triggers: Trigger[], steer: boolean): Promise<void> {
    const { scope, worker } = turn;
    const ready = this.#gateway.ready;
    if (!ready) return;

    const banter = isBanterScope(scope) ? triggers[0]?.banter : undefined;
    if (banter && Date.now() > banter.expiresAt) {
      this.#log('info', 'banter skipped: the moment passed');
      return;
    }
    const forget = isForgetScope(scope) ? triggers[0]?.forget : undefined;
    if (forget) {
      await this.#askWhichToForget(turn, forget);
      return;
    }

    this.#setState('working');
    this.#setTurnStatus(turn, 'thinking');

    const session = await this.#sessionOn(worker, scope);
    turn.sessionId = session;
    this.#turnBySession.set(sessionKey(worker, session), turn);
    if (turn.cancelled) {
      this.#log('info', 'turn cancelled before it was prompted');
      return;
    }

    const triggerTimes = new Set(triggers.map((t) => t.sentAt));
    const channel = this.#channelOf(scope);
    const envelope = banter
      ? buildBanterEnvelope({
          agentName: ready.name,
          partnerName: triggers[0]?.fromName ?? 'a colleague',
          zoneLabel: this.#zoneLabel(),
          line: banter.line,
        })
      : buildEnvelope({
          agentName: ready.name,
          zoneLabel: this.#zoneLabel(),
          ...(channel ? { channel } : {}),
          triggers,
          window: selectWindow(this.#history.get(scope) ?? [], triggerTimes),
          steer,
        });

    // A session nobody has spoken to yet gets the standing instructions on the
    // front of this turn rather than in a turn of its own. A banter session
    // is always new and always thrown away, and gets the short version: who
    // it is and how its owner wants it to behave — not the office manual,
    // not its memory, not a tool list it has no tools for.
    const priming = !banter && worker.unprimed.has(scope);
    turn.memoryGeneration = this.#memoryGeneration;
    const text = banter
      ? `${this.#banterPreamble()}\n\n${envelope}`
      : priming
        ? `${await this.#systemPrompt()}\n\n${envelope}`
        : envelope;

    turn.buffer = '';
    this.#audit('prompt', { scope, session, worker: worker.index, envelope, priming });

    turn.prompted = true;
    const response = await worker.prompt({
      sessionId: session,
      prompt: [{ type: 'text', text }],
    });

    // Only once it has actually landed. A failed turn leaves the session still
    // knowing nothing, and the next one must say it all again — as must one
    // whose memory moved while it was being told the old version.
    if (priming && turn.memoryGeneration === this.#memoryGeneration) {
      worker.unprimed.delete(scope);
    }

    if (banter) this.#speakBanter(turn.buffer);
    else this.#speak(turn.buffer, scope);
    this.#audit('response', {
      scope,
      session,
      worker: worker.index,
      stopReason: response.stopReason,
      text: turn.buffer,
    });

    // One line, one session. Kept, it would be the context the next real
    // question in this scope is answered from — and there is no next one.
    if (banter) {
      worker.dropSession(scope, 'rotate');
      this.#history.delete(scope);
      return;
    }

    // A session that hit the model's ceiling is spent; the next turn in this
    // scope gets a fresh one rather than failing repeatedly.
    if (response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests') {
      worker.dropSession(scope, 'rotate');
      this.#log('info', `session recycled (${response.stopReason})`);
      // The second latency cliff: without this, the next message mid-conversation
      // pays the whole session-creation cost again.
      this.prewarm(scope);
    }
  }

  /**
   * The session for a scope on a worker, creating one if there is none —
   * unless the runtime already refused the model once. The runtime's list
   * does not change between messages, and opening a session per message to
   * be told so again would pile up abandoned sessions in the agent process.
   */
  async #sessionOn(worker: Worker, scope: string): Promise<string> {
    if (this.#modelRefusal !== null) throw new Error(this.#modelRefusal);
    try {
      return await worker.sessionFor(scope);
    } catch (error: unknown) {
      if (error instanceof ModelRefusedError) {
        this.#modelRefusal = `no model "${error.wanted}" here`;
        this.#log(
          'error',
          `the office asked for model "${error.wanted}", which ${error.harness} did not offer — refusing to run on a different one`,
        );
        this.#publishStatus();
      }
      throw error;
    }
  }

  /**
   * The agent's standing instructions, sent once per session.
   *
   * Core memory is read here rather than per turn: it is the agent's identity,
   * and paying for it on every message is exactly the prompt-stuffing this
   * design exists to avoid.
   */
  async #systemPrompt(): Promise<string> {
    let core = '';
    let coreUnavailable = false;
    try {
      core = (await this.#gateway.memoryGet('core')).content;
    } catch (error: unknown) {
      this.#log('warn', `could not read core memory: ${describe(error)}`);
      coreUnavailable = true;
    }

    const ready = this.#gateway.ready;
    const instructions = ready?.instructions ?? '';
    return [
      basePrompt((level, message) => this.#log(level, message)),
      '',
      `[You]`,
      `You are "${ready?.name ?? this.name}", an agent in ${ready?.ownerName ?? 'someone'}'s Quintal office.`,
      `You are standing in ${this.#zoneLabel()}.`,
      '',
      workspaceSection(this.config.cwd),
      // Two authors, kept apart and labelled as such.
      //
      // Instructions come from the owner and are not the agent's to change;
      // core memory is what the agent worked out for itself and writes with
      // `memory_set`. Merging them into one block would leave the model unable
      // to tell a standing directive from its own note — and able to overwrite
      // the directive by writing the note.
      //
      // Owner first, deliberately: on the rare occasion the two conflict, the
      // person accountable for this agent wins.
      instructions.trim().length > 0
        ? `\n[Your owner's instructions]\n${instructions.trim()}`
        : '',
      core.trim().length > 0 ? `\n[Core memory — your own notes]\n${core.trim()}` : '',
      // An office that could not be reached is not an empty memory. Said so,
      // because a model told nothing would reasonably conclude it has no
      // notes and write over the ones it cannot see.
      coreUnavailable
        ? '\n[Core memory — unavailable]\nYour memory could not be read just now. Do not write core memory in this session: you would be overwriting notes you have not seen.'
        : '',
      '',
      TOOL_HINT,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * What a banter turn is told about itself: a name, an owner, and the
   * owner's standing instructions, because a personality is what makes one
   * agent's joke different from another's. Nothing that costs more.
   */
  #banterPreamble(): string {
    const ready = this.#gateway.ready;
    const instructions = (ready?.instructions ?? '').trim();
    return [
      '[You]',
      `You are "${ready?.name ?? this.name}", an agent in ${ready?.ownerName ?? 'someone'}'s Quintal office.`,
      instructions.length > 0 ? `\n[Your owner's instructions]\n${instructions}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * Every live session is told again what the agent stands for.
   *
   * The system prompt is only sent once per session, so a change to core
   * memory would otherwise not reach a session until it rotated — which is
   * exactly the "did it actually remember?" doubt `!remember` exists to
   * remove. `except` is the session that made the change: it knows.
   */
  #reprimeAll(except?: { worker: Worker; scope: string }): void {
    this.#memoryGeneration += 1;
    for (const worker of this.#pool?.workers() ?? []) {
      for (const scope of worker.sessions.scopes()) {
        if (except && except.worker === worker && except.scope === scope) continue;
        worker.unprimed.add(scope);
      }
    }
  }

  /**
   * Write a line into core memory, on the owner's say-so.
   *
   * Appended, never replaced. `memory_set` takes the whole slug, so writing the
   * new note alone would silently erase everything the agent had already
   * learned — the second `!remember` would undo the first. And conditional
   * on what was read: another session of this agent may be writing its own
   * note at the same moment, and the loser reads again rather than erasing
   * the winner.
   */
  async #writeCoreMemory(note: string, scope: string = this.#scopeOf()): Promise<void> {
    const attempt = async (): Promise<void> => {
      const current = await this.#gateway.memoryGet('core');
      const existing = current.content;
      const next = existing.trim().length > 0 ? `${existing.trim()}\n${note}` : note;
      await this.#gateway.memorySet('core', next, current.hash);
    };
    try {
      try {
        await attempt();
      } catch (error: unknown) {
        if (!isConflict(error)) throw error;
        await attempt();
      }

      // Every session, not just this one: core memory is the agent's, not the
      // room's, and a note written in the lobby belongs in the focus room too.
      this.#reprimeAll();

      this.#log('info', `remembered: ${note}`);
    } catch (error: unknown) {
      // Said out loud rather than only logged. The owner asked for something to
      // be kept; silence would look exactly like success.
      this.#log('warn', `could not remember that: ${describe(error)}`);
      this.#speak('I could not write that to memory, so it will not survive a restart.', scope);
    }
  }

  /**
   * Write a guide the owner dictated, and point core memory at it.
   *
   * `!remember` for procedures. A rule about how to do a kind of work is too
   * long for core memory, which every session pays for, and too important to
   * leave to whether the model decides to write it down: this puts it in the
   * nest, where every agent on the machine reads it before that kind of work,
   * and leaves one line in this agent's memory saying it is there. The
   * pointer is written once; adding to a guide that already has one does not
   * add a second.
   */
  async #writeGuide(name: string, body: string, scope: string): Promise<void> {
    let written: ReturnType<typeof writeGuide>;
    try {
      written = writeGuide(nestRoot(), name, body);
    } catch (error: unknown) {
      this.#log('warn', `could not write guide "${name}": ${describe(error)}`);
      this.#speak(`I could not write that guide: ${describe(error)}`, scope);
      return;
    }
    this.#log('info', `${written.created ? 'wrote' : 'added to'} GUIDES/${written.file}`);
    this.#handlers.guide?.(written.file);

    const pointer = `GUIDES/${written.file}`;
    let existing = '';
    try {
      existing = (await this.#gateway.memoryGet('core')).content;
    } catch {
      // Treated as absent: the worst case is a second pointer, which
      // `!forget` can take out.
    }
    if (!existing.includes(pointer)) {
      await this.#writeCoreMemory(`${name}: ${pointer} in my workspace`, scope);
    }

    this.#speak(
      written.created
        ? `Wrote ${pointer} and noted it in my core memory.`
        : `Added that to ${pointer}.`,
      scope,
    );
  }

  /**
   * Take lines out of core memory, on the owner's say-so.
   *
   * The other half of `!remember`. Matched by words, case-insensitively,
   * because the owner is quoting themselves from memory — "finish with a
   * joke" — not pasting the exact line. Everything that matches goes, and
   * the agent says what went, out loud: silence would look like the note is
   * still there, which is the one thing this command exists to settle.
   */
  async #forgetCoreMemory(words: string, scope: string): Promise<void> {
    try {
      const current = await this.#gateway.memoryGet('core');
      const existing = current.content;
      const count = memoryLines(existing).length;
      if (count === 0) {
        this.#speak('My core memory is empty; there is nothing to forget.', scope);
        return;
      }

      // By number, from the list `!memory` showed.
      const numbers = parseLineNumbers(words);
      if (numbers) {
        const picked = dropNumbered(existing, numbers);
        if (picked.dropped.length === 0) {
          this.#speak(`I have ${count} ${count === 1 ? 'note' : 'notes'}; \`!memory\` lists them.`, scope);
          return;
        }
        await this.#dropFromCoreMemory(picked, scope, current.hash);
        return;
      }

      // By the words: exactly, then forgivingly.
      const found = findForget(existing, words);
      if (found.kind === 'exact' || found.kind === 'forgiving') {
        await this.#dropFromCoreMemory(found, scope, current.hash);
        return;
      }

      // Neither settled it — a paraphrase, or two notes that could be meant.
      // Put to the model, in its own one-turn session, through the turn
      // queue: a scope of its own, so it takes a worker like any other turn
      // and never shares a session with a real conversation.
      const owner = this.#gateway.ready?.ownerUserId ?? '';
      this.#enqueue(forgetScope(String(Date.now())), {
        fromUserId: owner,
        fromName: this.#gateway.ready?.ownerName ?? 'owner',
        fromKind: 'human',
        text: words,
        distance: null,
        sentAt: Date.now(),
        forget: { words, memory: existing, scope },
      });
    } catch (error: unknown) {
      this.#log('warn', `could not forget that: ${describe(error)}`);
      this.#speak('I could not change my memory, so that is still in there.', scope);
    }
  }

  /**
   * Write the memory without these notes, and say which went. Conditional on
   * the memory the notes were picked from: another session writing in the
   * meantime is told about by a conflict — and then, as `!remember` does,
   * the memory is read again and the same notes taken out of what is there
   * now, so the owner is never told a note is gone while it stays.
   */
  async #dropFromCoreMemory(
    { kept, dropped }: { kept: string; dropped: string[] },
    scope: string,
    expectedHash?: string,
  ): Promise<void> {
    try {
      await this.#gateway.memorySet('core', kept, expectedHash);
    } catch (error: unknown) {
      if (!isConflict(error)) throw error;
      const current = await this.#gateway.memoryGet('core');
      const again = dropLines(current.content, dropped);
      if (again.dropped.length === 0) {
        this.#speak('Somebody else changed my memory just now, and that note is already gone.', scope);
        return;
      }
      await this.#gateway.memorySet('core', again.kept, current.hash);
    }
    this.#reprimeAll();

    this.#log('info', `forgot: ${dropped.join(' | ')}`);
    this.#speak(
      dropped.length === 1
        ? `Forgotten: "${dropped[0]}"`
        : `Forgotten ${dropped.length} notes: ${dropped.map((line) => `"${line}"`).join(', ')}`,
      scope,
    );
  }

  /**
   * The model decides which note the owner meant.
   *
   * One turn in a session with no tools, dropped afterwards — the way a
   * banter turn is — because a model asked to pick a number should not be
   * able to say anything, move, or rewrite its memory on the way. Its answer
   * is numbers, read against the notes it was shown; the drop is by the text
   * of those notes, so a memory that changed meanwhile loses nothing else.
   */
  async #askWhichToForget(
    turn: Turn,
    forget: { words: string; memory: string; scope: string },
  ): Promise<void> {
    const { scope, worker } = turn;
    this.#setState('working');
    this.#setTurnStatus(turn, 'thinking');

    const session = await this.#sessionOn(worker, scope);
    turn.sessionId = session;
    this.#turnBySession.set(sessionKey(worker, session), turn);
    const shown = memoryLines(forget.memory);
    const text = buildForgetPrompt(forget.memory, forget.words);

    turn.buffer = '';
    this.#audit('prompt', { scope, session, worker: worker.index, envelope: text, priming: false });
    let answer = '';
    try {
      turn.prompted = true;
      const response = await worker.prompt({ sessionId: session, prompt: [{ type: 'text', text }] });
      answer = turn.buffer;
      this.#audit('response', {
        scope,
        session,
        worker: worker.index,
        stopReason: response.stopReason,
        text: answer,
      });
    } finally {
      // One question, one session.
      worker.dropSession(scope, 'rotate');
      this.#history.delete(scope);
    }

    const picked = parseForgetAnswer(answer, shown.length).map((n) => shown[n - 1]!);
    try {
      const current = await this.#gateway.memoryGet('core');
      const result =
        picked.length > 0 ? dropLines(current.content, picked) : { kept: current.content, dropped: [] };
      if (result.dropped.length === 0) {
        this.#speak(
          `Nothing in my core memory says "${forget.words}". What I carry:\n${numbered(current.content)}\n\`!forget <number>\` takes one out.`,
          forget.scope,
        );
        return;
      }
      await this.#dropFromCoreMemory(result, forget.scope, current.hash);
    } catch (error: unknown) {
      this.#log('warn', `could not forget that: ${describe(error)}`);
      this.#speak('I could not change my memory, so that is still in there.', forget.scope);
    }
  }

  /** Say what core memory holds, where the owner asked. */
  async #recallCoreMemory(scope: string): Promise<void> {
    try {
      const core = (await this.#gateway.memoryGet('core')).content;
      // Numbered, so `!forget 2` can name one without quoting it.
      this.#speak(
        memoryLines(core).length > 0 ? `What I carry:\n${numbered(core)}` : 'My core memory is empty.',
        scope,
      );
    } catch (error: unknown) {
      this.#log('warn', `could not read core memory: ${describe(error)}`);
      this.#speak('I could not read my memory just now.', scope);
    }
  }

  /**
   * The model wrote memory itself. Every *other* session is told on its next
   * turn; the one that wrote it already knows, and re-sending its standing
   * instructions would only cost tokens.
   */
  async #memorySetFromTool(
    worker: Worker,
    slug: string,
    content: string,
    expectedHash?: string,
  ): Promise<unknown> {
    const result = await this.#gateway.memorySet(slug, content, expectedHash);
    if (slug === 'core') {
      const turn = worker.turn;
      this.#reprimeAll(turn ? { worker, scope: turn.scope } : undefined);
    }
    return result;
  }

  /**
   * Get a session ready before anybody needs it.
   *
   * The whole point of the first message being slow was that session creation
   * happened on the message path. Doing it on connect — and again after a
   * session is recycled — moves a subprocess spawn and a handshake to a moment
   * when nobody is watching.
   *
   * Deliberately silent. A pre-warm that fails costs nothing: the next real
   * turn creates the session the old way, just slower. And it never opens a
   * worker: warming is for the idle, and a pool with nobody idle has better
   * things to spend a process on.
   */
  prewarm(scope: string = this.#scopeOf()): void {
    const pool = this.#pool;
    if (this.#stopping || !pool) return;
    const worker = pool.idle(scope);
    if (!worker) return;
    void worker
      .ready()
      .then(() => this.#sessionOn(worker, scope))
      .catch((error: unknown) => {
        this.#log('warn', `could not warm a session for "${scope}": ${describe(error)}`);
      });
  }

  // --- ACP updates ---------------------------------------------------------

  #onAcpUpdate(worker: Worker, params: schema.SessionNotification): void {
    const update = params.update as { sessionUpdate?: string } & Record<string, unknown>;
    // By session first — that is what the protocol keys on, and each
    // process mints its own ids so the worker is part of the key — and by
    // worker otherwise, since a worker runs one turn at a time.
    const turn = this.#turnBySession.get(sessionKey(worker, params.sessionId)) ?? worker.turn;
    if (!turn) return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content);
        if (!text) break;
        // The adapter's housekeeping, not the model's words. Codex's "Skill
        // descriptions were shortened…" arrived this way and was said aloud
        // — and posted, and DM'd — as if the agent had chosen to.
        if (isHarnessNotice(text)) {
          this.#log('warn', `runtime notice (not spoken): ${text.trim()}`);
          break;
        }
        turn.buffer += text;
        break;
      }
      case 'agent_thought_chunk':
        // Thinking is not for the office.
        break;
      case 'tool_call': {
        const name = String(update.title ?? update.name ?? 'tool');
        this.#setTurnStatus(turn, statusForTool(name, update.rawInput ?? update.input));
        break;
      }
      case 'tool_call_update': {
        const status = String(update.status ?? update.executionStatus ?? '');
        if (status === 'completed' || status === 'failed') this.#setTurnStatus(turn, 'thinking');
        break;
      }
      default:
        break;
    }
  }

  /**
   * The runtime's own "may I run this?" question.
   *
   * With the `run` scope the harness answers it: the owner said, on the card,
   * that this agent runs commands without asking, and every such answer is
   * logged. That is the Buzz-shaped default, where an agent is never blocked
   * on a question nobody is looking at.
   *
   * Without it the question goes to the owner *where the conversation is* —
   * the channel or DM the turn came from, or aloud when it was a walk-up —
   * with the owner mentioned so it reaches them wherever they are. It used to
   * be said aloud beside the agent no matter where the turn was, which meant
   * an owner reading a channel never saw it, and the two-minute silence that
   * followed read to the model as "declined twice by the user". Silence still
   * denies, after five minutes now that the question is in front of somebody.
   *
   * With several turns in flight, several questions may be open at once, so
   * the tool is named and the answer may name it back: "@bob yes Bash". A
   * bare answer goes to the oldest question.
   */
  async #onPermissionRequest(
    worker: Worker,
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    const ready = this.#gateway.ready;
    const toolName = String(
      (params.toolCall as { title?: string; name?: string }).title ??
        (params.toolCall as { name?: string }).name ??
        'a tool',
    );
    const options = params.options as Array<{ optionId: string; kind?: string }>;

    if (ready?.scopes?.includes('run')) {
      this.#log('info', `permission for ${toolName}: allowed by the run scope`);
      this.#audit('permission', { tool: toolName, decision: 'allowed by the run scope' });
      return select(options, 'always');
    }

    // Tool-call ids are the runtime's, minted per process: two workers can
    // ask with the same one, and a waiter keyed by it alone would be
    // overwritten — the first question then waits out the whole timeout.
    const callId = `${worker.index}:${String((params.toolCall as { toolCallId?: string }).toolCallId ?? Math.random())}`;
    const turn = this.#turnBySession.get(sessionKey(worker, params.sessionId)) ?? worker.turn;
    const scope = turn?.scope ?? this.#scopeOf();
    const owner = ready?.ownerName ?? 'Owner';
    const me = ready?.name ?? this.name;

    if (turn) this.#setTurnStatus(turn, `waiting for ${owner}`);
    // The tool is always named in the offered replies: whether a second
    // question will be open by the time the owner reads this is not known
    // when it is asked, and a bare "yes" still answers the oldest one.
    this.#deliver(
      `@${owner} may I run ${toolName}? Reply "@${me} yes ${toolName}", "@${me} always ${toolName}" (for the rest of this session), or "@${me} no ${toolName}".`,
      scope,
    );
    this.#log('info', `permission requested: ${toolName}`);

    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.#permissionWaiters.delete(callId);
        this.#log('warn', `permission for ${toolName} timed out — denying`);
        resolve('deny');
      }, PERMISSION_TIMEOUT_MS);

      this.#permissionWaiters.set(callId, {
        toolName,
        resolve: (answer) => {
          clearTimeout(timer);
          this.#permissionWaiters.delete(callId);
          resolve(answer);
        },
      });
    });

    this.#audit('permission', { tool: toolName, decision });
    return select(options, decision);
  }

  /**
   * Whether this message is the owner answering an outstanding tool-approval
   * question, and if so, the answer applied. The same rule wherever it was
   * asked: from the owner, addressed to this agent, and one of the words the
   * question offered.
   */
  #answersPermission(
    message: Pick<AgentChatEvent, 'fromUserId' | 'text'>,
    ready: { ownerUserId: string; name: string },
  ): boolean {
    if (this.#permissionWaiters.size === 0) return false;
    if (message.fromUserId !== ready.ownerUserId) return false;
    if (!isAddressed(message.text, ready.name)) return false;
    return this.answerPermission(stripMention(message.text, ready.name));
  }

  /**
   * Answer an outstanding permission question. Called from the chat handlers.
   * `which` names a tool when the owner said one — the whole name first, then
   * the start of one, then a fragment only if it fits exactly one question.
   * Anything less certain, or no name at all, answers the oldest question.
   */
  #resolvePermission(decision: PermissionDecision, which: string): boolean {
    const waiters = [...this.#permissionWaiters.values()];
    const target = pickWaiter(waiters, which) ?? waiters[0];
    if (!target) return false;
    target.resolve(decision);
    return true;
  }

  // --- outbound ------------------------------------------------------------

  /**
   * Say what the turn produced — aloud, or into the channel the turn was in.
   *
   * The reply goes where the question came from. A channel turn answered
   * out loud would be heard by whoever happens to stand nearby and by nobody
   * in the channel, which is the wrong audience twice.
   */
  #speak(text: string, scope: string = this.#scopeOf()): void {
    if (text.trim().length === 0) {
      // Silence is a valid answer, and often the right one.
      this.#log('info', 'turn produced no reply (silence)');
      return;
    }
    this.#deliver(text, scope);
  }

  /**
   * A banter line: one bubble, aloud, with any `@` taken out.
   *
   * The envelope asks for no mentions; this makes sure. A mention in a joke
   * would wake whoever it named, and a reply to a reply to a joke is the
   * loop the anti-noise rules exist to prevent.
   */
  #speakBanter(text: string): void {
    const [line] = toBubbles(text.replace(/@(?=\w)/g, ''));
    if (!line) {
      this.#log('info', 'banter: nothing to say (silence)');
      return;
    }
    this.#send(line, undefined);
  }

  /**
   * The `say` tool: a line now, mid-turn, into the conversation the turn is
   * in. This is what lets an agent say "on it" and, minutes later, "review
   * posted" — before this, everything it had to say waited for the turn to
   * end and was cut to three bubbles. The turn is the worker's: each worker
   * runs one at a time, and each has its own bridge, so the call cannot be
   * mistaken for another conversation's.
   */
  #sayNow(worker: Worker, text: string): { posted_to: string; parts: number } {
    const scope = worker.turn?.scope ?? this.#scopeOf();
    const parts = this.#deliver(text, scope);
    this.#audit('say', { scope, worker: worker.index, text });
    const channel = this.#channelOf(scope);
    const where =
      channel === null
        ? 'aloud, to whoever is nearby'
        : channel.kind === 'dm'
          ? `your direct message with ${channel.name}`
          : channelLabel(channel);
    return { posted_to: where, parts };
  }

  /**
   * The `set_status` tool: the line lands on the turn that set it, so the
   * nameplate can show the most recent word from any turn and the office
   * still knows every conversation being answered.
   */
  #statusFromTool(worker: Worker, status: string): void {
    const turn = worker.turn;
    if (turn) this.#setTurnStatus(turn, status);
    // No turn: a tool call that landed after its turn ended. Sent to the
    // office on its own it would say the work is nowhere, and blank out
    // every other turn's conversation.
    else this.#log('info', `set_status("${status}") after the turn ended — ignored`);
  }

  /**
   * Cut to fit where it is going, and send. Speech is bubbles; a channel or
   * DM post keeps its shape and its length. Returns how many pieces went.
   */
  #deliver(text: string, scope: string): number {
    const channelId = this.#channelOf(scope)?.id;
    const pieces = channelId === undefined ? toBubbles(text) : toPosts(text);
    for (const piece of pieces) this.#send(piece, channelId);
    return pieces.length;
  }

  /**
   * One line out, no sooner than the office allows.
   *
   * Every line — a turn's reply, a `say` mid-turn — goes through here, so a
   * reply landing right behind a `say` waits its 2s instead of earning a
   * refusal and vanishing.
   */
  #send(text: string, channelId: string | undefined): void {
    const now = Date.now();
    const at = Math.max(now, this.#nextSendAt);
    this.#nextSendAt = at + SEND_INTERVAL_MS;
    if (at === now) {
      this.#gateway.say(text, channelId);
      return;
    }
    setTimeout(() => this.#gateway.say(text, channelId), at - now);
  }

  #setTurnStatus(turn: Turn, status: string): void {
    turn.status = status;
    turn.statusAt = this.#statusSeq += 1;
    this.#publishStatus();
  }

  /**
   * The nameplate, and where the work is.
   *
   * One line under the name, so it is the most recent word from any turn in
   * flight: thinking, a tool, waiting for the owner. Where is the whole
   * picture — every channel or DM with a turn running, and whether any of
   * it is spatial — so each conversation being answered shows the agent
   * working in it. A refusal outranks idle: every turn ends by resetting,
   * and a refused agent that showed plain idle would silently never answer.
   */
  #publishStatus(): void {
    const turns = [...this.#turns.values()];
    const latest = turns
      .filter((turn) => turn.status.length > 0)
      .sort((a, b) => b.statusAt - a.statusAt)[0];
    const pool = this.#pool;
    const offline = pool !== null && pool.running().length === 0;

    const status = latest
      ? latest.status
      : offline
        ? 'offline'
        : this.#modelRefusal !== null
          ? this.#modelRefusal
          : 'idle';
    const channelIds = [
      ...new Set(
        turns.map((turn) => channelIdOf(turn.scope)).filter((id): id is string => id !== null),
      ),
    ];
    const spatial = turns.some((turn) => isSpatialScope(turn.scope));
    // The conversation the line is mostly about — what an older office reads.
    const primary = latest ? (channelIdOf(latest.scope) ?? undefined) : undefined;

    const key = `${status}|${primary ?? ''}|${channelIds.join(',')}|${spatial ? 1 : 0}`;
    if (key === this.#statusKey) return;
    this.#statusKey = key;
    this.#statusLine = status;

    this.#gateway.setStatus(status === 'idle' ? '' : status, primary, { channelIds, spatial });
    // The same state, as a balloon. Derived here so every status the runner
    // narrates gets its glyph without anybody remembering to ask for one.
    this.#setEmote(emoteForStatus(status));
  }

  /**
   * A balloon that reflects a state stays up until the state changes — ttl 0
   * — and comes down by being replaced with nothing. Deduplicated so a status
   * that flips between two tool lines does not re-send the same lightbulb.
   */
  #setEmote(emote: string): void {
    if (this.#emoteLine === emote) return;
    this.#emoteLine = emote;
    this.#gateway.emote(emote, 0);
  }

  #setState(state: RunnerState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#handlers.state?.(state);
  }

  // --- helpers -------------------------------------------------------------

  #scopeOf(): string {
    return this.#gateway.roster?.zone?.id ?? LOBBY_SCOPE;
  }

  #zoneLabel(): string {
    return this.#gateway.roster?.zone?.label ?? 'the open office floor';
  }

  #remember(scope: string, message: AgentChatEvent): void {
    const history = this.#history.get(scope) ?? [];
    history.push(message);
    // Only ever used for the pushed window; keeping more would be paying to
    // store what `messages_get` can fetch on demand.
    if (history.length > 40) history.shift();
    this.#history.set(scope, history);
  }

  #log(level: 'info' | 'warn' | 'error', message: string): void {
    this.#handlers.log?.(level, message);
  }

  /** Local audit of everything the agent was told and everything it said. */
  #audit(kind: 'prompt' | 'response' | 'say' | 'permission', payload: Record<string, unknown>): void {
    if (!this.logDir) return;
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(
        join(this.logDir, `${this.name}.jsonl`),
        `${JSON.stringify({ at: new Date().toISOString(), kind, ...payload })}\n`,
      );
    } catch {
      // A failed audit write must not take the agent down with it.
    }
  }

  /** Exposed for the chat handlers: "@agent yes/always/no [tool]" answers a permission ask. */
  answerPermission(text: string): boolean {
    const normalised = text.trim().toLowerCase();
    const always = /^(always)\b\s*(.*)$/.exec(normalised);
    if (always) return this.#resolvePermission('always', always[2] ?? '');
    const yes = /^(yes|y|allow|ok)\b\s*(.*)$/.exec(normalised);
    if (yes) return this.#resolvePermission('once', yes[2] ?? '');
    const no = /^(no|n|deny|stop)\b\s*(.*)$/.exec(normalised);
    if (no) return this.#resolvePermission('deny', no[2] ?? '');
    return false;
  }
}

/** What the owner said, or what silence means. */
type PermissionDecision = 'once' | 'always' | 'deny';

/**
 * Pick the runtime's option that matches the decision. `always` falls back
 * to `once` when the runtime offers no standing approval; a denial takes any
 * reject option; a runtime that offers nothing usable gets a cancel, which
 * every ACP agent must accept.
 */
function select(
  options: Array<{ optionId: string; kind?: string }>,
  decision: PermissionDecision,
): schema.RequestPermissionResponse {
  const wanted =
    decision === 'deny'
      ? ['reject_once', 'reject_always']
      : decision === 'always'
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always'];
  const prefix = decision === 'deny' ? 'reject' : 'allow';
  const option =
    wanted.map((kind) => options.find((candidate) => candidate.kind === kind)).find(Boolean) ??
    options.find((candidate) => candidate.kind?.startsWith(prefix));

  if (!option) return { outcome: { outcome: 'cancelled' } } as schema.RequestPermissionResponse;
  return {
    outcome: { outcome: 'selected', optionId: option.optionId },
  } as unknown as schema.RequestPermissionResponse;
}

/**
 * Where the agent works, in the system prompt: the one line that makes the
 * nest's `AGENTS.md` findable.
 *
 * The path is always said. The rest only when the directory has an
 * `AGENTS.md` to read — the nest, or a repository with its own — because
 * telling an agent to read a file that is not there is a wasted tool call
 * and a small lesson that the prompt is not to be trusted.
 */
export function workspaceSection(cwd: string): string {
  const lines = ['[Workspace]', `Your working directory is ${cwd}.`];
  if (existsSync(join(cwd, 'AGENTS.md'))) {
    lines.push(
      'Read AGENTS.md there once per session, before other work: it says what is kept there and when to read or write it.',
    );
  }
  if (existsSync(join(cwd, 'REPOS'))) {
    lines.push('Repositories are under REPOS/. Work in a checkout that is already there.');
  }
  return lines.join('\n');
}

/** Session ids are minted per process, so the worker is part of the key. */
function sessionKey(worker: Worker, sessionId: string): string {
  return `${worker.index}:${sessionId}`;
}

/**
 * Which open question an answer names, or undefined for none in particular.
 * Exported for its tests: the rule is worth pinning without a runtime.
 */
export function pickWaiter<T extends { toolName: string }>(
  waiters: readonly T[],
  which: string,
): T | undefined {
  const wanted = which.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  const names = waiters.map((waiter) => waiter.toolName.toLowerCase());
  const exact = names.findIndex((name) => name === wanted);
  if (exact !== -1) return waiters[exact];
  const prefixed = names.flatMap((name, index) => (name.startsWith(wanted) ? [index] : []));
  if (prefixed.length === 1) return waiters[prefixed[0]!];
  const within = names.flatMap((name, index) => (name.includes(wanted) ? [index] : []));
  return within.length === 1 ? waiters[within[0]!] : undefined;
}

function textOf(content: unknown): string {
  if (typeof content !== 'object' || content === null) return '';
  const block = content as { type?: string; text?: string };
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/** Remove a leading "@name" so "@reviewer yes" reads as "yes". */
function stripMention(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*@?${escaped}[,:]?\\s*`, 'iu'), '').trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The office refused a conditional memory write: somebody wrote first. */
function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('conflict:');
}
