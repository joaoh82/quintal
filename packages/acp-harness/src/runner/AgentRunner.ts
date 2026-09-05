import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import {
  AGENT_CHAT_INTERVAL_MS,
  channelLabel,
  emoteForStatus,
  isAddressed,
  parseAgentCommand,
  type RuntimeStatus,
  type AgentChannelChatEvent,
  type AgentChatEvent,
  type AgentMentionEvent,
  type ChannelRef,
} from '@quintal/shared';

import { AgentProcess } from '../acp/agent-process.js';
import type { AgentConfig } from '../config.js';
import { GatewayClient, type Gateway } from '../gateway/client.js';
import { startBridge, type BridgeHandle } from '../mcp/bridge.js';
import { pickModel } from '../models.js';
import { basePrompt } from './base-prompt.js';
import { LOBBY_SCOPE, SessionStore } from './sessions.js';

/**
 * Scope prefix for a channel. Zones are scoped by zone id; a channel scope
 * cannot collide with one because no zone id carries a colon.
 */
const CHANNEL_SCOPE = 'channel:';
import {
  MAX_BATCH,
  TOOL_HINT,
  buildEnvelope,
  selectWindow,
  type Trigger,
} from './context.js';
import { isHarnessNotice, statusForTool, toBubbles, toPosts } from './outbound.js';

/**
 * One agent, alive in one office.
 *
 * This is where the plan's §2.9 rules actually live: sessions per zone, one
 * prompt in flight, batched triggers, steer notes instead of interrupts, and
 * owner-only commands. Everything else in the package is plumbing around this.
 */

export type RunnerState = 'starting' | 'connected' | 'working' | 'offline' | 'stopped';

export interface RunnerEvents {
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  state: (state: RunnerState) => void;
}

const PERMISSION_TIMEOUT_MS = 120_000;

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

/** The machine credential, when this agent was defined in the office. */
function hostCredential(
  config: AgentConfig,
): { token: string; agentId: string } | undefined {
  return config.hostToken && config.agentId
    ? { token: config.hostToken, agentId: config.agentId }
    : undefined;
}

export class AgentRunner {
  readonly name: string;

  #gateway: Gateway;
  #process: AgentProcess | null = null;
  #bridge: BridgeHandle | null = null;
  readonly #sessions: SessionStore;
  /**
   * Scopes whose session exists but has not been told anything yet.
   *
   * Separate from the session book because it tracks what the *model* has been
   * told, not what is allocated: a session can be created long before anybody
   * speaks to it, and pre-warming relies on exactly that gap.
   */
  readonly #unprimed = new Set<string>();
  /**
   * Session creations still in flight, by scope.
   *
   * Without this, two callers that both find no session both make one. That was
   * always possible and became likely the moment sessions were pre-warmed:
   * warming is deliberately not awaited, so there is now always an in-flight
   * creation at exactly the moment the first message tends to arrive. The loser
   * of that race leaks a session on the agent side and starts an unprimed one
   * on ours.
   */
  readonly #creating = new Map<string, Promise<string>>();
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
  /** The balloon last asked for, so the same one is not sent twice. */
  #emoteLine = '';
  /** When the next line may leave: everything we say is paced through here. */
  #nextSendAt = 0;

  #busy = false;
  #currentScope: string | null = null;
  #currentAcpSession: string | null = null;
  /** Set while a turn is running, so the next prompt is marked as a steer. */
  #steerPending = false;

  #state: RunnerState = 'starting';
  #statusLine = '';
  #stopping = false;
  #restarts = 0;
  #reconnectAttempts = 0;

  /** Streamed text for the turn in flight, assembled before it's spoken. */
  #responseBuffer = '';
  /** Resolvers for permission questions asked in chat, keyed by tool call id. */
  readonly #permissionWaiters = new Map<string, (allow: boolean) => void>();

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
      new GatewayClient(
        config.url,
        config.key,
        config.mapId,
        config.workspaceId,
        hostCredential(config),
      );
    this.#sessions = new SessionStore({
      onEvict: (record, reason) => {
        this.#log('info', `session for "${record.scope}" ended (${reason})`);
      },
    });
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

  // --- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this.#stopping = false;
    await this.#connectGateway();
    await this.#startAgent();
    this.#setState('connected');
    this.#setStatus('idle');

    // Not awaited: the agent is connected and usable now, and a slow handshake
    // with its MCP server should hold nobody up. By the time somebody speaks,
    // the expensive half is usually already done.
    this.prewarm();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#setState('stopped');
    this.#process?.stop();
    this.#process = null;
    await this.#bridge?.close();
    this.#bridge = null;
    await this.#gateway.leave().catch(() => {});
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
          this.config.key,
          this.config.mapId,
          this.config.workspaceId,
          hostCredential(this.config),
        );
      }
      await this.#connectGateway();
      this.#setState('connected');
      this.#setStatus(this.#statusLine || 'idle');
      this.#log('info', 'reconnected');
    } catch (error: unknown) {
      this.#log('warn', `reconnect failed: ${describe(error)}`);
      void this.#reconnect();
    }
  }

  async #startAgent(): Promise<void> {
    this.#bridge = await startBridge(
      this.#gateway,
      (tool) => {
        this.#log('info', `tool: ${tool}`);
      },
      { say: (text) => this.#sayNow(text) },
    );

    const bridge = this.#bridge;
    const proc = new AgentProcess({
      command: this.config.command,
      cwd: this.config.cwd,
      onUpdate: (params) => this.#onAcpUpdate(params),
      onPermission: (params) => this.#onPermissionRequest(params),
      onStderr: (line) => {
        this.#log('warn', `[${this.config.harness}] ${line}`);
        if (line.includes('cannot be launched inside another')) {
          this.#log(
            'error',
            'this harness refuses to run nested — boot the fleet from a plain shell, ' +
              'or use the default claude-code command (see COMPAT.md)',
          );
        }
      },
      onExit: (code) => {
        if (this.#stopping) return;
        this.#log('warn', `agent process exited (${code ?? 'signal'})`);
        void this.#restartAgent();
      },
      env: {
        QUINTAL_BRIDGE_URL: bridge.url,
        QUINTAL_BRIDGE_TOKEN: bridge.token,
      },
    });

    const info = await proc.start();
    this.#process = proc;
    this.#sessions.clear();
    this.#unprimed.clear();
    // Anything still being created belongs to the process that just went away.
    this.#creating.clear();
    this.#log(
      'info',
      `${info.agentInfo?.name ?? this.config.harness} ready (ACP v${String(info.protocolVersion)})`,
    );
  }

  /**
   * One quiet restart on a crash.
   *
   * The office sees "offline" in the status line and nothing else — a crashed
   * agent announcing its own resurrection in chat is noise, and the second
   * failure is the one worth telling a human about.
   */
  async #restartAgent(): Promise<void> {
    this.#busy = false;
    this.#setStatus('offline');
    this.#setState('offline');

    if (this.#restarts >= 1) {
      this.#log('error', 'agent crashed again — not restarting');
      this.#gateway.say(`I've stopped working — ${this.config.harness} keeps crashing.`);
      return;
    }

    this.#restarts += 1;
    try {
      await this.#startAgent();
      this.#setState('connected');
      this.#setStatus('idle');
      this.#log('info', 'agent restarted');
    } catch (error: unknown) {
      this.#log('error', `restart failed: ${describe(error)}`);
    }
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
    if (
      message.fromUserId === ready.ownerUserId &&
      isAddressed(message.text, ready.name) &&
      this.answerPermission(stripMention(message.text, ready.name))
    ) {
      return;
    }

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
      rootedAtReposDir: this.config.rootedAtReposDir,
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
    const scope = `${CHANNEL_SCOPE}${message.channel.id}`;
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

  /** The channel or DM a scope is, or null for a spatial scope. */
  #channelOf(scope: string): ChannelRef | null {
    if (!scope.startsWith(CHANNEL_SCOPE)) return null;
    const id = scope.slice(CHANNEL_SCOPE.length);
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
        if (this.#currentAcpSession) this.#process?.cancel(this.#currentAcpSession);
        this.#busy = false;
        this.#setStatus('idle');
        this.#log('info', 'turn cancelled by owner');
        return true;
      }
      case '!rotate': {
        // The scope the command arrived in: `!rotate` in a channel rotates
        // the channel's session, not the one for wherever we are standing.
        const dropped = this.#sessions.drop(scope, 'rotate');
        this.#unprimed.delete(scope);
        this.#log('info', `rotated session for "${scope}"${dropped ? '' : ' (none live)'}`);
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
   * Exactly one prompt in flight, ever.
   *
   * Messages that arrive mid-turn wait and are delivered on the next natural
   * boundary as a steer note. Cancelling a running turn because somebody said
   * something is how you get an agent that never finishes anything.
   */
  async #drain(): Promise<void> {
    if (this.#busy || this.#stopping) return;

    const entry = [...this.#queues.entries()].find(([, queue]) => queue.length > 0);
    if (!entry) return;

    const [scope, queue] = entry;
    const triggers = queue.splice(0, MAX_BATCH);
    if (queue.length === 0) this.#queues.delete(scope);

    this.#busy = true;
    this.#currentScope = scope;
    const steer = this.#steerPending;
    this.#steerPending = false;

    try {
      await this.#runTurn(scope, triggers, steer);
    } catch (error: unknown) {
      this.#log('error', `turn failed: ${describe(error)}`);
    } finally {
      this.#busy = false;
      this.#currentScope = null;
      this.#currentAcpSession = null;
      this.#setStatus('idle');
      this.#setState('connected');
      // Anything that arrived while we were working is a steer, not a fresh ask.
      if ([...this.#queues.values()].some((q) => q.length > 0)) {
        this.#steerPending = true;
        void this.#drain();
      }
    }
  }

  async #runTurn(scope: string, triggers: Trigger[], steer: boolean): Promise<void> {
    const proc = this.#process;
    const ready = this.#gateway.ready;
    if (!proc || !ready) return;

    this.#setState('working');
    this.#setStatus('thinking');

    const session = await this.#sessionFor(scope);
    this.#currentAcpSession = session;

    const triggerTimes = new Set(triggers.map((t) => t.sentAt));
    const channel = this.#channelOf(scope);
    const envelope = buildEnvelope({
      agentName: ready.name,
      zoneLabel: this.#zoneLabel(),
      ...(channel ? { channel } : {}),
      triggers,
      window: selectWindow(this.#history.get(scope) ?? [], triggerTimes),
      steer,
    });

    // A session nobody has spoken to yet gets the standing instructions on the
    // front of this turn rather than in a turn of its own.
    const priming = this.#unprimed.has(scope);
    const text = priming ? `${await this.#systemPrompt()}\n\n${envelope}` : envelope;

    this.#responseBuffer = '';
    this.#audit('prompt', { scope, session, envelope, priming });

    const response = await proc.prompt({
      sessionId: session,
      prompt: [{ type: 'text', text }],
    });

    // Only once it has actually landed. A failed turn leaves the session still
    // knowing nothing, and the next one must say it all again.
    if (priming) this.#unprimed.delete(scope);

    this.#speak(this.#responseBuffer, scope);
    this.#audit('response', {
      scope,
      session,
      stopReason: response.stopReason,
      text: this.#responseBuffer,
    });

    // A session that hit the model's ceiling is spent; the next turn in this
    // scope gets a fresh one rather than failing repeatedly.
    if (response.stopReason === 'max_tokens' || response.stopReason === 'max_turn_requests') {
      this.#sessions.drop(scope, 'rotate');
      this.#unprimed.delete(scope);
      this.#log('info', `session recycled (${response.stopReason})`);
      // The second latency cliff: without this, the next message mid-conversation
      // pays the whole session-creation cost again.
      this.prewarm(scope);
    }
  }

  /**
   * The ACP session for a scope, creating one if there is none.
   *
   * Creation is the expensive half and none of it is model work: the agent CLI
   * spawns our MCP server as a subprocess and completes a handshake with it.
   * That is why this is worth doing before anybody is waiting — see `prewarm`.
   *
   * It deliberately does **not** send the system prompt. That used to happen
   * here, as its own awaited `prompt()` call, which meant the first message to
   * an agent paid for two complete model turns: one to load the standing
   * instructions and one to answer. The instructions now ride along with the
   * first real turn instead, so there is one turn either way — and an agent
   * nobody talks to costs nothing.
   */
  async #sessionFor(scope: string): Promise<string> {
    const existing = this.#sessions.get(scope);
    if (existing) return existing.sessionId;

    // Already refused once: the runtime's list does not change between
    // messages, and opening a session per message to be told so again would
    // pile up abandoned sessions in the agent process.
    if (this.#modelRefusal !== null) throw new Error(this.#modelRefusal);

    // Join a creation already under way rather than starting a second one.
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

  async #createSession(scope: string): Promise<string> {
    const proc = this.#process;
    const bridge = this.#bridge;
    if (!proc || !bridge) throw new Error('agent is not running');

    const created = await proc.newSession({
      cwd: this.config.cwd,
      mcpServers: [
        {
          name: 'quintal-tools',
          command: process.execPath,
          args: mcpServerArgs(),
          env: [
            { name: 'QUINTAL_BRIDGE_URL', value: bridge.url },
            { name: 'QUINTAL_BRIDGE_TOKEN', value: bridge.token },
          ],
        },
      ],
    } as schema.NewSessionRequest);

    await this.#applyModel(proc, created);

    this.#sessions.put(scope, created.sessionId);
    // A fresh session has been told nothing yet.
    this.#unprimed.add(scope);
    this.#log('info', `new session for "${scope}" (${this.#sessions.size} live)`);

    return created.sessionId;
  }

  /**
   * Run on the model the owner chose, or do not run.
   *
   * The model is picked from what the agent advertised at `session/new`, and
   * set with `session/set_config_option` — never a command-line flag, so a
   * value from the office can never become argv on this machine. An agent
   * that was not offered the model its card names refuses the session rather
   * than answering on whatever the default is: an agent quietly running on a
   * different model than it claims is the worse failure, because nobody can
   * see it.
   */
  async #applyModel(proc: AgentProcess, created: schema.NewSessionResponse): Promise<void> {
    const wanted = this.config.modelId;
    if (!wanted) return;

    const choice = pickModel((created as { configOptions?: unknown }).configOptions, wanted);
    if (!choice) {
      this.#modelRefusal = `no model "${wanted}" here`;
      this.#setStatus(this.#modelRefusal);
      this.#log(
        'error',
        `the office asked for model "${wanted}", which ${this.config.harness} did not offer — refusing to run on a different one`,
      );
      // The session that was opened to find this out is not kept; nothing
      // will be said in it.
      proc.cancel(created.sessionId);
      throw new Error(`model "${wanted}" is not offered by ${this.config.harness}`);
    }

    await proc.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: choice.configId,
      type: 'id',
      value: choice.value,
    } as schema.SetSessionConfigOptionRequest);
    this.#modelRefusal = null;
    this.#log('info', `model set to ${wanted}`);
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
    try {
      core = (await this.#gateway.memoryGet('core')).content;
    } catch (error: unknown) {
      this.#log('warn', `could not read core memory: ${describe(error)}`);
    }

    const ready = this.#gateway.ready;
    const instructions = ready?.instructions ?? '';
    return [
      basePrompt(),
      '',
      `[You]`,
      `You are "${ready?.name ?? this.name}", an agent in ${ready?.ownerName ?? 'someone'}'s Quintal office.`,
      `You are standing in ${this.#zoneLabel()}.`,
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
      '',
      TOOL_HINT,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * Write a line into core memory, on the owner's say-so.
   *
   * Appended, never replaced. `memory_set` takes the whole slug, so writing the
   * new note alone would silently erase everything the agent had already
   * learned — the second `!remember` would undo the first.
   *
   * Existing sessions are already primed, and the system prompt is only sent
   * once per session. So the scopes are marked unprimed afterwards: without
   * that, a note written now would not reach the model until the session
   * rotated, which is exactly the "did it actually remember?" doubt this
   * command exists to remove.
   */
  async #writeCoreMemory(note: string, scope: string = this.#scopeOf()): Promise<void> {
    try {
      const existing = (await this.#gateway.memoryGet('core')).content;
      const next = existing.trim().length > 0 ? `${existing.trim()}\n${note}` : note;

      await this.#gateway.memorySet('core', next);

      // Every scope, not just this one: core memory is the agent's, not the
      // room's, and a note written in the lobby belongs in the focus room too.
      for (const scope of this.#sessions.scopes()) this.#unprimed.add(scope);

      this.#log('info', `remembered: ${note}`);
    } catch (error: unknown) {
      // Said out loud rather than only logged. The owner asked for something to
      // be kept; silence would look exactly like success.
      this.#log('warn', `could not remember that: ${describe(error)}`);
      this.#speak('I could not write that to memory, so it will not survive a restart.', scope);
    }
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
   * turn creates the session the old way, just slower.
   */
  prewarm(scope: string = this.#scopeOf()): void {
    if (this.#stopping || !this.#process) return;
    void this.#sessionFor(scope).catch((error: unknown) => {
      this.#log('warn', `could not warm a session for "${scope}": ${describe(error)}`);
    });
  }

  // --- ACP updates ---------------------------------------------------------

  #onAcpUpdate(params: schema.SessionNotification): void {
    const update = params.update as { sessionUpdate?: string } & Record<string, unknown>;

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
        this.#responseBuffer += text;
        break;
      }
      case 'agent_thought_chunk':
        // Thinking is not for the office.
        break;
      case 'tool_call': {
        const name = String(update.title ?? update.name ?? 'tool');
        this.#setStatus(statusForTool(name, update.rawInput ?? update.input));
        break;
      }
      case 'tool_call_update': {
        const status = String(update.status ?? update.executionStatus ?? '');
        if (status === 'completed' || status === 'failed') this.#setStatus('thinking');
        break;
      }
      default:
        break;
    }
  }

  /**
   * Tool approval, asked in the office.
   *
   * Visible to the owner only — a permission prompt is not a conversation the
   * room should have to watch. A proper UI arrives in Phase 1; until then the
   * reply convention is "@name yes" / "@name no", and silence denies.
   */
  async #onPermissionRequest(
    params: schema.RequestPermissionRequest,
  ): Promise<schema.RequestPermissionResponse> {
    const ready = this.#gateway.ready;
    const toolName = String(
      (params.toolCall as { title?: string; name?: string }).title ??
        (params.toolCall as { name?: string }).name ??
        'a tool',
    );
    const callId = String((params.toolCall as { toolCallId?: string }).toolCallId ?? Math.random());

    this.#setStatus(`waiting for ${ready?.ownerName ?? 'owner'}`);
    this.#gateway.say(
      `${ready?.ownerName ?? 'Owner'}: may I run ${toolName}? Reply "@${ready?.name ?? this.name} yes" or "no".`,
    );
    this.#log('info', `permission requested: ${toolName}`);

    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#permissionWaiters.delete(callId);
        this.#log('warn', `permission for ${toolName} timed out — denying`);
        resolve(false);
      }, PERMISSION_TIMEOUT_MS);

      this.#permissionWaiters.set(callId, (allow) => {
        clearTimeout(timer);
        this.#permissionWaiters.delete(callId);
        resolve(allow);
      });
    });

    const options = params.options as Array<{ optionId: string; kind?: string }>;
    const wanted = allowed ? 'allow_once' : 'reject_once';
    const option =
      options.find((candidate) => candidate.kind === wanted) ??
      options.find((candidate) => candidate.kind?.startsWith(allowed ? 'allow' : 'reject')) ??
      options[0];

    if (!option) return { outcome: { outcome: 'cancelled' } } as schema.RequestPermissionResponse;

    return {
      outcome: { outcome: 'selected', optionId: option.optionId },
    } as unknown as schema.RequestPermissionResponse;
  }

  /** Answer an outstanding permission question. Called from the chat handler. */
  #resolvePermission(allow: boolean): boolean {
    const [first] = [...this.#permissionWaiters.values()];
    if (!first) return false;
    first(allow);
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
   * The `say` tool: a line now, mid-turn, into the conversation the turn is
   * in. This is what lets an agent say "on it" and, minutes later, "review
   * posted" — before this, everything it had to say waited for the turn to
   * end and was cut to three bubbles.
   */
  #sayNow(text: string): { posted_to: string; parts: number } {
    const scope = this.#currentScope ?? this.#scopeOf();
    const parts = this.#deliver(text, scope);
    this.#audit('say', { scope, text });
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

  #setStatus(status: string): void {
    // A refusal outranks idle. Every turn ends by resetting to idle, and a
    // refused turn ending that way would show a plain idle agent that
    // silently never answers — the reason it will not is the one line an
    // owner needs to read on the nameplate.
    const effective = status === 'idle' && this.#modelRefusal !== null ? this.#modelRefusal : status;
    if (this.#statusLine === effective) return;
    this.#statusLine = effective;
    // Where the work is, so the conversation being answered can show it: the
    // channel or DM of the turn in flight, or nothing for a zone turn.
    const workingIn =
      effective === 'idle' ? undefined : this.#channelOf(this.#currentScope ?? '')?.id;
    this.#gateway.setStatus(effective === 'idle' ? '' : effective, workingIn);
    // The same state, as a balloon. Derived here so every status the runner
    // narrates gets its glyph without anybody remembering to ask for one.
    this.#setEmote(emoteForStatus(effective));
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
  #audit(kind: 'prompt' | 'response' | 'say', payload: Record<string, unknown>): void {
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

  /** Exposed for the chat handler: "@agent yes/no" answers a permission ask. */
  answerPermission(text: string): boolean {
    const normalised = text.trim().toLowerCase();
    if (/^(yes|y|allow|ok)\b/.test(normalised)) return this.#resolvePermission(true);
    if (/^(no|n|deny|stop)\b/.test(normalised)) return this.#resolvePermission(false);
    return false;
  }
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

/** Absolute path to this package's CLI entry, for spawning the MCP server. */
/**
 * How to invoke this same program again, to run the MCP tool server.
 *
 * Two shapes, because there are two ways this ships. Under Node the entry is a
 * real file and has to be named: `node …/cli.js mcp-server`. Inside the bundled
 * app it is a bun single-file executable whose entry point is embedded, and
 * `import.meta.url` resolves into bun's virtual filesystem — `/$bunfs/cli.js`,
 * a path that exists only inside the running binary.
 *
 * Passing that to the compiled binary does not run a script. It is read as the
 * subcommand, the process exits with `unknown command "/$bunfs/cli.js"`, and
 * the agent is left with a tool server that never started — so it can talk but
 * cannot look, move, or remember. Chat still worked, which is why this survived
 * a bundle that had otherwise been tested.
 *
 * Decided by asking whether the entry is a file that exists, rather than by
 * sniffing for bun. That is the property that actually matters, and it stays
 * true whatever a future runtime calls its virtual paths.
 */
export function mcpServerArgs(entry?: string): string[] {
  const path = entry ?? new URL('../cli.js', import.meta.url).pathname;
  return existsSync(path) ? [path, 'mcp-server'] : ['mcp-server'];
}
