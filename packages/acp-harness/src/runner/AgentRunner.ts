import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type * as schema from '@agentclientprotocol/sdk';
import {
  isAddressed,
  parseAgentCommand,
  type RuntimeStatus,
  type AgentChatEvent,
  type AgentMentionEvent,
} from '@quintal/shared';

import { AgentProcess } from '../acp/agent-process.js';
import type { AgentConfig } from '../config.js';
import { GatewayClient } from '../gateway/client.js';
import { startBridge, type BridgeHandle } from '../mcp/bridge.js';
import { basePrompt } from './base-prompt.js';
import { LOBBY_SCOPE, SessionStore } from './sessions.js';
import {
  MAX_BATCH,
  TOOL_HINT,
  buildEnvelope,
  selectWindow,
  type Trigger,
} from './context.js';
import { statusForTool, toBubbles } from './outbound.js';

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
 * How close someone must be for an unaddressed remark to count as talking to
 * you. Roughly "standing at your desk" rather than "somewhere in the room".
 *
 * A fallback only: the office serves its own value in `agent:ready`, because an
 * owner who widens walk-up distance in settings expects agents to obey it.
 */
const WALK_UP_RADIUS_FALLBACK_TILES = 3;

export class AgentRunner {
  readonly name: string;

  #gateway: GatewayClient;
  #process: AgentProcess | null = null;
  #bridge: BridgeHandle | null = null;
  readonly #sessions: SessionStore;

  /** Pending triggers, per scope. Drained into one prompt per turn. */
  readonly #queues = new Map<string, Trigger[]>();
  /** Conversation history per scope, for the pushed window. */
  readonly #history = new Map<string, AgentChatEvent[]>();

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

  constructor(
    private readonly config: AgentConfig,
    private readonly logDir?: string,
  ) {
    this.name = config.name;
    this.#gateway = new GatewayClient(config.url, config.key, config.mapId);
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
      this.#gateway = new GatewayClient(this.config.url, this.config.key, this.config.mapId);
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
    this.#bridge = await startBridge(this.#gateway, (tool) => {
      this.#log('info', `tool: ${tool}`);
    });

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

    if (this.#handleOwnerCommand(message)) return;

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
   * `!cancel`, `!rotate`, `!shutdown` — owner only.
   *
   * Checked against `ownerUserId`, never the display name: names are editable,
   * so name matching would let anyone in the workspace shut down somebody
   * else's agent by renaming themselves.
   */
  #handleOwnerCommand(message: AgentChatEvent): boolean {
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
        const scope = this.#scopeOf();
        const dropped = this.#sessions.drop(scope, 'rotate');
        this.#log('info', `rotated session for "${scope}"${dropped ? '' : ' (none live)'}`);
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
    const envelope = buildEnvelope({
      agentName: ready.name,
      zoneLabel: this.#zoneLabel(),
      triggers,
      window: selectWindow(this.#history.get(scope) ?? [], triggerTimes),
      steer,
    });

    this.#responseBuffer = '';
    this.#audit('prompt', { scope, session, envelope });

    const response = await proc.prompt({
      sessionId: session,
      prompt: [{ type: 'text', text: envelope }],
    });

    this.#speak(this.#responseBuffer);
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
      this.#log('info', `session recycled (${response.stopReason})`);
    }
  }

  async #sessionFor(scope: string): Promise<string> {
    const existing = this.#sessions.get(scope);
    if (existing) return existing.sessionId;

    const proc = this.#process;
    const bridge = this.#bridge;
    if (!proc || !bridge) throw new Error('agent is not running');

    // Core memory is injected once, at session creation — not per turn. It is
    // the agent's standing identity, and paying for it on every message is
    // exactly the prompt-stuffing this design exists to avoid.
    let core = '';
    try {
      core = (await this.#gateway.memoryGet('core')).content;
    } catch (error: unknown) {
      this.#log('warn', `could not read core memory: ${describe(error)}`);
    }

    const ready = this.#gateway.ready;
    const system = [
      basePrompt(),
      '',
      `[You]`,
      `You are "${ready?.name ?? this.name}", an agent in ${ready?.ownerName ?? 'someone'}'s Quintal office.`,
      `You are standing in ${this.#zoneLabel()}.`,
      core.trim().length > 0 ? `\n[Core memory]\n${core.trim()}` : '',
      '',
      TOOL_HINT,
    ]
      .filter((line) => line !== '')
      .join('\n');

    const created = await proc.newSession({
      cwd: this.config.cwd,
      mcpServers: [
        {
          name: 'quintal-tools',
          command: process.execPath,
          args: [harnessEntry(), 'mcp-server'],
          env: [
            { name: 'QUINTAL_BRIDGE_URL', value: bridge.url },
            { name: 'QUINTAL_BRIDGE_TOKEN', value: bridge.token },
          ],
        },
      ],
    } as schema.NewSessionRequest);

    this.#sessions.put(scope, created.sessionId);
    this.#log('info', `new session for "${scope}" (${this.#sessions.size} live)`);

    // The system prompt rides in as the first user turn: ACP has no dedicated
    // system-prompt field, and every harness we tested treats an opening
    // instruction message this way.
    await proc.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: system }],
    });

    return created.sessionId;
  }

  // --- ACP updates ---------------------------------------------------------

  #onAcpUpdate(params: schema.SessionNotification): void {
    const update = params.update as { sessionUpdate?: string } & Record<string, unknown>;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content);
        if (text) this.#responseBuffer += text;
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

  #speak(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Silence is a valid answer, and often the right one.
      this.#log('info', 'turn produced no reply (silence)');
      return;
    }

    const bubbles = toBubbles(trimmed);
    for (const [index, bubble] of bubbles.entries()) {
      // The office rate-limits agents to one message every 2s; pace ourselves
      // rather than earning refusals we would then have to retry.
      setTimeout(() => this.#gateway.say(bubble), index * 2100);
    }
  }

  #setStatus(status: string): void {
    if (this.#statusLine === status) return;
    this.#statusLine = status;
    this.#gateway.setStatus(status === 'idle' ? '' : status);
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
  #audit(kind: 'prompt' | 'response', payload: Record<string, unknown>): void {
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
function harnessEntry(): string {
  return new URL('../cli.js', import.meta.url).pathname;
}
