import { ErrorCode, Room, ServerError, type Client, logger } from '@colyseus/core';
import {
  AGENT_CHAT_INTERVAL_MS,
  AGENT_CORE_MEMORY_MAX_BYTES,
  AGENT_HEARTBEAT_MS,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MOVE_INTERVAL_MS,
  AGENT_REVOCATION_POLL_MS,
  AGENT_STATUS_MAX_LENGTH,
  AgentMessage,
  AgentServerMessage,
  CHAT_MAX_LENGTH,
  ClientMessage,
  DEFAULT_OFFICE_SETTINGS,
  MESSAGES_GET_MAX,
  OfficePlayer,
  OfficeState,
  RECONNECTION_SECONDS,
  ServerMessage,
  TICK_MS,
  createPlayer,
  directionFromIntent,
  findPath,
  followPath,
  memoryLimitFor,
  nearestWalkable,
  normalize,
  spawnFor,
  stepMovement,
  tileCentre,
  toTile,
  isAddressed,
  mentionedNames,
  zoneAt,
  type AgentChatEvent,
  type AgentErrorPayload,
  type AgentLookAroundPayload,
  type AgentMemoryGetPayload,
  type AgentHostReportPayload,
  type AgentMemorySetPayload,
  type AgentMessagesGetPayload,
  type AgentMoveToPayload,
  type AgentOccupant,
  type AgentReadyPayload,
  type AgentResultPayload,
  type AgentRosterEvent,
  type AgentSayPayload,
  type AgentSetStatusPayload,
  type ChatBroadcastPayload,
  type ChatSendPayload,
  type Direction,
  type ErrorPayload,
  type InputPayload,
  type LookAroundResult,
  type MapZone,
  type MemoryGetResult,
  type MemorySetResult,
  type MessagesGetResult,
  type MoveIntent,
  type OfficeMap,
  type OfficeSettings,
  type StatusPayload,
  type TilePoint,
  type WalkToPayload,
} from '@quintal/shared';
import {
  MemoryLimitError,
  MemorySlugError,
  getAgentMemory,
  getDb,
  getOfficeSettings,
  setAgentMemory,
  type AgentIdentity,
} from '@quintal/shared/db';
import { loadOfficeMap } from '@quintal/shared/maps';

import {
  allowChat,
  allowMove,
  audit,
  authenticateAgent,
  authenticateHostAgent,
  findRevoked,
  hasScope,
  markSeen,
  persistHostReport,
  persistStatus,
  type AgentSession,
} from '../agents/gateway.js';
import { displayNameFor, verifySessionToken } from '../auth/session.js';
import { ChatRateLimiter } from './chat-limiter.js';
import { ChatLog, type RoomMessage } from './chat-log.js';

interface OfficeRoomOptions {
  mapId?: unknown;
  token?: unknown;
  agentKey?: unknown;
  /** A machine's credential, used with `agentId` instead of an agent key. */
  hostToken?: unknown;
  agentId?: unknown;
}

/** What `onAuth` hands to `onJoin`. Humans and agents come through one door. */
type JoinAuth =
  | {
      kind: 'human';
      userId: string;
      name: string;
      isGuest: boolean;
      description: string;
    }
  | { kind: 'agent'; identity: AgentIdentity };

interface PlayerSim {
  intent: MoveIntent;
  path: TilePoint[];
  away: boolean;
  /** Set for agents; absent for humans. */
  agent?: AgentSession;
}

const STATUS_MAX_LENGTH = 60;

/** Tiles of clearance an arriving agent tries to leave around everyone else. */
const AGENT_SPAWN_GAP_TILES = 4;

/**
 * The office.
 *
 * Authoritative: clients send *intent* and the server decides where anybody
 * actually is. That applies identically to humans and agents — an agent asks to
 * walk somewhere and the server walks it, at human speed, along a real path.
 * There is no message in either protocol that sets a position, so nothing can
 * teleport and nothing can outrun a person.
 *
 * Agents are first-class occupants and deliberately conspicuous ones: they hold
 * the same kind of slot in room state as a human, carry `kind: "agent"` so every
 * consumer can mark them, and are attributed to an owner everywhere they appear.
 */
export class OfficeRoom extends Room<OfficeState> {
  override maxClients = 64;

  #map!: OfficeMap;
  readonly #sims = new Map<string, PlayerSim>();
  readonly #chatLimiter = new ChatRateLimiter();
  readonly #chatLog = new ChatLog();
  /** sessionId -> agent identity, for everyone in the room who isn't a person. */
  readonly #agents = new Map<string, AgentIdentity>();
  #heartbeatTimer?: NodeJS.Timeout;
  #revocationTimer?: NodeJS.Timeout;
  #settingsTimer?: NodeJS.Timeout;

  /** Refreshed from the database, so a change in /settings takes effect live. */
  #settings: OfficeSettings = { ...DEFAULT_OFFICE_SETTINGS };

  /**
   * Who addressed whom from out of earshot, and when.
   *
   * Being reachable by name across the map is only half a conversation: without
   * this, an agent summoned from the far side of the office answers into empty
   * air, because its reply travels by normal proximity. Keyed
   * `speaker -> [listeners]`, short-lived, so a reply finds the person who
   * asked and nobody else.
   */
  readonly #awaitingReply = new Map<string, Map<string, number>>();

  override onCreate(options: OfficeRoomOptions): void {
    const mapId = typeof options.mapId === 'string' ? options.mapId : 'hq';
    this.#map = loadOfficeMap(mapId);

    const state = new OfficeState();
    state.mapId = mapId;
    this.state = state;

    this.setPatchRate(TICK_MS);
    this.setSimulationInterval((deltaMs) => this.#tick(deltaMs), TICK_MS);

    // --- human protocol ---
    this.onMessage(ClientMessage.Input, (client, payload: InputPayload) =>
      this.#onInput(client, payload),
    );
    this.onMessage(ClientMessage.WalkTo, (client, payload: WalkToPayload) =>
      this.#onWalkTo(client, payload),
    );
    this.onMessage(ClientMessage.Chat, (client, payload: ChatSendPayload) =>
      this.#onChat(client, payload?.text),
    );
    this.onMessage(ClientMessage.SetStatus, (client, payload: StatusPayload) =>
      this.#onStatus(client, payload?.status),
    );

    // --- agent protocol (docs/GATEWAY.md) ---
    this.onMessage(AgentMessage.Say, (client, payload: AgentSayPayload) =>
      this.#onAgentSay(client, payload),
    );
    this.onMessage(AgentMessage.MoveTo, (client, payload: AgentMoveToPayload) =>
      this.#onAgentMoveTo(client, payload),
    );
    this.onMessage(AgentMessage.SetStatus, (client, payload: AgentSetStatusPayload) =>
      this.#onAgentSetStatus(client, payload),
    );
    this.onMessage(AgentMessage.LookAround, (client, payload: AgentLookAroundPayload) =>
      this.#onAgentLookAround(client, payload),
    );
    this.onMessage(AgentMessage.MessagesGet, (client, payload: AgentMessagesGetPayload) =>
      this.#onAgentMessagesGet(client, payload),
    );
    this.onMessage(AgentMessage.MemoryGet, (client, payload: AgentMemoryGetPayload) =>
      void this.#onAgentMemoryGet(client, payload),
    );
    this.onMessage(AgentMessage.MemorySet, (client, payload: AgentMemorySetPayload) =>
      void this.#onAgentMemorySet(client, payload),
    );
    this.onMessage(AgentMessage.HostReport, (client, payload: AgentHostReportPayload) =>
      this.#onAgentHostReport(client, payload),
    );

    void this.#refreshSettings();
    this.#settingsTimer = setInterval(() => void this.#refreshSettings(), 10_000);

    this.#heartbeatTimer = setInterval(() => this.#sendHeartbeats(), AGENT_HEARTBEAT_MS);
    this.#revocationTimer = setInterval(
      () => void this.#kickRevokedAgents(),
      AGENT_REVOCATION_POLL_MS,
    );

    logger.info(`[office] room ${this.roomId} created on map "${mapId}"`);
  }

  /**
   * One door, three credentials. An agent presents `{ agentKey }`; a machine
   * running an office-defined agent presents `{ hostToken, agentId }`; a human
   * presents a Better Auth session token. Anything else is turned away.
   */
  override async onAuth(_client: Client, options: OfficeRoomOptions): Promise<JoinAuth> {
    // ServerError, not Error: a plain throw reaches the client as an empty
    // 4213 with no message, which for a documented public protocol means an
    // agent developer gets a bare number and no idea what they did wrong.
    // A machine acting as one of its owner's agents. Checked first because it
    // carries an explicit agent id; an agent key carries only itself.
    if (options.hostToken !== undefined) {
      const identity = await authenticateHostAgent(options.hostToken, options.agentId);
      if (!identity) {
        throw new ServerError(
          ErrorCode.AUTH_FAILED,
          'Unknown or revoked host token, or that agent is not yours. Manage machines at /settings/agents.',
        );
      }
      return { kind: 'agent', identity };
    }

    if (options.agentKey !== undefined) {
      const identity = await authenticateAgent(options.agentKey);
      if (!identity) {
        throw new ServerError(
          ErrorCode.AUTH_FAILED,
          'Unknown or revoked agent key. Create one at /settings/agents.',
        );
      }
      return { kind: 'agent', identity };
    }

    const user = await verifySessionToken(options.token);
    if (!user) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'No valid session. Sign in again.');
    }
    return {
      kind: 'human',
      userId: user.userId,
      name: displayNameFor(user),
      isGuest: user.isGuest,
      description: user.description,
    };
  }

  override onJoin(client: Client, _options: OfficeRoomOptions, auth: JoinAuth): void {
    if (auth.kind === 'agent') {
      this.#joinAsAgent(client, auth.identity);
      return;
    }

    const spawn = spawnFor(this.#map, 'human');
    this.state.players.set(
      client.sessionId,
      createPlayer({
        userId: auth.userId,
        name: auth.name,
        x: tileCentre(spawn.x, this.#map.tileSize),
        y: tileCentre(spawn.y, this.#map.tileSize),
        kind: 'human',
        isGuest: auth.isGuest,
        description: auth.description,
      }),
    );
    this.#sims.set(client.sessionId, { intent: { x: 0, y: 0 }, path: [], away: false });

    logger.info(`[office] ${auth.name} (${client.sessionId}) joined ${this.roomId}`);
    this.#broadcastRosterToAgents();
  }

  #joinAsAgent(client: Client, identity: AgentIdentity): void {
    // Agents wake up in the Agent Bay, not the human lobby. Where a worker
    // stands says what it is as loudly as any badge.
    const spawn = this.#agentSpawn();

    this.state.players.set(
      client.sessionId,
      createPlayer({
        userId: identity.id,
        name: identity.name,
        x: tileCentre(spawn.x, this.#map.tileSize),
        y: tileCentre(spawn.y, this.#map.tileSize),
        kind: 'agent',
        spriteKey: identity.spriteKey,
        status: identity.status,
        ownerName: identity.ownerName,
        scopes: identity.scopes,
      }),
    );

    const session: AgentSession = { identity, lastChatAt: 0, lastMoveAt: 0 };
    this.#sims.set(client.sessionId, {
      intent: { x: 0, y: 0 },
      path: [],
      away: false,
      agent: session,
    });
    this.#agents.set(client.sessionId, identity);

    audit(identity.id, 'session.connected', {
      sessionId: client.sessionId,
      roomId: this.roomId,
      tile: spawn,
    });
    markSeen(identity.id);

    const zone = zoneAt(this.#map, spawn.x, spawn.y);
    const ready: AgentReadyPayload = {
      agentId: identity.id,
      sessionId: client.sessionId,
      name: identity.name,
      ownerUserId: identity.ownerUserId,
      ownerName: identity.ownerName,
      scopes: identity.scopes,
      mapId: this.state.mapId,
      tile: spawn,
      zoneId: zone?.id ?? null,
      zones: this.#map.zones.map((z) => ({ id: z.id, label: z.label, kind: z.kind })),
      serverTime: Date.now(),
      limits: {
        chatIntervalMs: AGENT_CHAT_INTERVAL_MS,
        moveIntervalMs: AGENT_MOVE_INTERVAL_MS,
        statusMaxLength: AGENT_STATUS_MAX_LENGTH,
        messagesGetMax: MESSAGES_GET_MAX,
        memoryMaxBytes: AGENT_MEMORY_MAX_BYTES,
        coreMemoryMaxBytes: AGENT_CORE_MEMORY_MAX_BYTES,
        chatRadiusTiles: this.#settings.chatRadiusTiles,
        walkUpRadiusTiles: this.#settings.walkUpRadiusTiles,
      },
    };
    client.send(AgentServerMessage.Ready, ready);
    this.#sendRoster(client.sessionId);

    logger.info(
      `[office] agent ${identity.name} (${identity.id}) joined ${this.roomId} for ${identity.ownerName}`,
    );
    this.#broadcastRosterToAgents();
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const sim = this.#sims.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    const agent = this.#agents.get(client.sessionId);

    if (agent) {
      audit(agent.id, 'session.disconnected', { sessionId: client.sessionId, consented });
    }

    if (consented === true || !player || !sim) {
      this.#removePlayer(client.sessionId);
      this.#broadcastRosterToAgents();
      return;
    }

    sim.intent = { x: 0, y: 0 };
    sim.path = [];
    sim.away = true;
    player.moving = false;
    player.status = 'away';
    this.#broadcastRosterToAgents();

    try {
      await this.allowReconnection(client, RECONNECTION_SECONDS);
      sim.away = false;
      player.status = agent ? agent.status : '';
      if (agent) audit(agent.id, 'session.connected', { reconnected: true });
      logger.info(`[office] ${client.sessionId} reconnected to ${this.roomId}`);
    } catch {
      this.#removePlayer(client.sessionId);
      logger.info(`[office] ${client.sessionId} did not come back`);
    }
    this.#broadcastRosterToAgents();
  }

  override onDispose(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    if (this.#revocationTimer) clearInterval(this.#revocationTimer);
    if (this.#settingsTimer) clearInterval(this.#settingsTimer);
    logger.info(`[office] room ${this.roomId} disposed`);
  }

  // --- public API ----------------------------------------------------------

  /**
   * Route anyone to a tile. Humans reach this through click-to-move, agents
   * through `move_to` — same pathfinder, same speed, no shortcuts for either.
   */
  walkTo(sessionId: string, tileX: number, tileY: number): boolean {
    const player = this.state.players.get(sessionId);
    const sim = this.#sims.get(sessionId);
    if (!player || !sim || sim.away) return false;

    const goal = nearestWalkable(this.#map, { x: Math.trunc(tileX), y: Math.trunc(tileY) });
    if (!goal) return false;

    const path = findPath(this.#map, this.#tileOf(player), goal);
    if (path.length === 0) return false;

    sim.intent = { x: 0, y: 0 };
    sim.path = path;
    return true;
  }

  /** Walk to the middle of a named zone. The agent-facing way to say "go here". */
  walkToZone(sessionId: string, zoneId: string): boolean {
    const zone = this.#map.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return false;

    const centre = {
      x: zone.bounds.x + Math.floor(zone.bounds.width / 2),
      y: zone.bounds.y + Math.floor(zone.bounds.height / 2),
    };
    return this.walkTo(sessionId, centre.x, centre.y);
  }

  // --- simulation ----------------------------------------------------------

  #tick(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    for (const [sessionId, sim] of this.#sims) {
      const player = this.state.players.get(sessionId);
      if (!player || sim.away) continue;

      if (sim.intent.x !== 0 || sim.intent.y !== 0) {
        const next = stepMovement(this.#map, player, sim.intent, deltaSeconds);
        this.#apply(player, next.x, next.y, directionFromIntent(sim.intent, player.dir), true);
      } else if (sim.path.length > 0) {
        const { position, consumed, intent } = followPath(
          this.#map,
          player,
          sim.path,
          deltaSeconds,
        );
        if (consumed > 0) sim.path = sim.path.slice(consumed);
        const arrived = sim.path.length === 0;
        this.#apply(
          player,
          position.x,
          position.y,
          directionFromIntent(intent, player.dir),
          !arrived,
        );
        if (arrived && sim.agent) {
          const tile = this.#tileOf(player);
          audit(sim.agent.identity.id, 'effect.moved', {
            tile,
            zoneId: zoneAt(this.#map, tile.x, tile.y)?.id ?? null,
          });
          this.#sendRoster(sessionId);
        }
      } else if (player.moving) {
        player.moving = false;
      }
    }
  }

  #apply(player: OfficePlayer, x: number, y: number, dir: Direction, moving: boolean): void {
    if (player.x !== x) player.x = x;
    if (player.y !== y) player.y = y;
    if (player.dir !== dir) player.dir = dir;
    if (player.moving !== moving) player.moving = moving;
  }

  // --- human messages ------------------------------------------------------

  #onInput(client: Client, payload: InputPayload): void {
    const sim = this.#sims.get(client.sessionId);
    if (!sim || sim.away || sim.agent) return; // agents don't hold arrow keys

    const intent = normalize({ x: clampAxis(payload?.x), y: clampAxis(payload?.y) });
    sim.intent = intent;
    if (intent.x !== 0 || intent.y !== 0) sim.path = [];
  }

  #onWalkTo(client: Client, payload: WalkToPayload): void {
    const sim = this.#sims.get(client.sessionId);
    if (sim?.agent) return; // agents use agent:move_to, which is rate limited

    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.#sendError(client, 'invalid_move', 'Target must be a tile coordinate.');
      return;
    }
    this.walkTo(client.sessionId, x, y);
  }

  #onStatus(client: Client, status: unknown): void {
    const sim = this.#sims.get(client.sessionId);
    if (sim?.agent) return; // agents use agent:set_status
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const next = String(status ?? '').slice(0, STATUS_MAX_LENGTH).trim();
    if (player.status !== next) player.status = next;
  }

  #onChat(client: Client, rawText: unknown): void {
    const speaker = this.state.players.get(client.sessionId);
    if (!speaker) return;

    const text = String(rawText ?? '').trim();
    if (text.length === 0) return;

    if (text.length > CHAT_MAX_LENGTH) {
      this.#sendError(
        client,
        'invalid_message',
        `Messages are limited to ${CHAT_MAX_LENGTH} characters.`,
      );
      return;
    }

    if (!this.#chatLimiter.tryConsume(client.sessionId)) {
      const retryAfter = this.#chatLimiter.retryAfterSeconds(client.sessionId);
      this.#sendError(client, 'rate_limited', `Slow down — try again in ${retryAfter}s.`);
      return;
    }

    this.#deliverChat(client.sessionId, speaker, text);
  }

  /**
   * Send a line of speech into the room. Proximity for everyone, plus mentions
   * for agents — an agent has to be reachable by name from across the office,
   * or asking it to do something means walking over to it first.
   */
  #deliverChat(sessionId: string, speaker: OfficePlayer, text: string): void {
    const sentAt = Date.now();
    const tile = this.#tileOf(speaker);
    const radius = this.#settings.chatRadiusTiles;

    const record: RoomMessage = {
      from: sessionId,
      fromUserId: speaker.userId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt,
      x: speaker.x,
      y: speaker.y,
      zoneId: zoneAt(this.#map, tile.x, tile.y)?.id ?? null,
    };
    this.#chatLog.push(record);

    const humanPayload: ChatBroadcastPayload = {
      from: sessionId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt,
    };

    const addressed = mentionedNames(text);
    const owed = this.#collectReplyDebt(sessionId, sentAt);

    for (const [listenerId, listener] of this.state.players) {
      const distance = this.#tileDistance(speaker, listener);
      const withinEarshot = distance <= radius;
      const byName = addressed.includes(listener.name.toLowerCase());
      // Somebody who addressed this speaker from across the room is owed the
      // answer, wherever they are standing now.
      const owedThis = owed.has(listenerId);

      if (!withinEarshot && !byName && !owedThis) continue;

      const target = this.clients.getById(listenerId);
      if (!target) continue;

      const agent = this.#agents.get(listenerId);
      if (agent) {
        if (withinEarshot) {
          target.send(AgentServerMessage.NearbyChat, {
            from: sessionId,
            fromUserId: speaker.userId,
            fromName: speaker.name,
            fromKind: speaker.kind,
            text,
            distance: round(distance),
            sentAt,
          } satisfies AgentChatEvent);
        } else if (listenerId !== sessionId) {
          target.send(AgentServerMessage.Mention, {
            from: sessionId,
            fromUserId: speaker.userId,
            fromName: speaker.name,
            fromKind: speaker.kind,
            text,
            sentAt,
          });
        }
      } else {
        target.send(ServerMessage.Chat, humanPayload);
      }

      // Addressing somebody out of earshot opens a short window for their
      // reply to come back to you.
      if (byName && !withinEarshot && listenerId !== sessionId) {
        this.#oweReply(listenerId, sessionId, sentAt);
      }
    }
  }

  /** Record that `speaker` owes `listener` a reply they can actually hear. */
  #oweReply(speakerId: string, listenerId: string, at: number): void {
    if (this.#settings.replyWindowSeconds <= 0) return;
    const debts = this.#awaitingReply.get(speakerId) ?? new Map<string, number>();
    debts.set(listenerId, at);
    this.#awaitingReply.set(speakerId, debts);
  }

  /** Who is still owed a reply from this speaker, clearing what has expired. */
  #collectReplyDebt(speakerId: string, now: number): Set<string> {
    const debts = this.#awaitingReply.get(speakerId);
    if (!debts) return new Set();

    const windowMs = this.#settings.replyWindowSeconds * 1000;
    const live = new Set<string>();
    for (const [listenerId, at] of debts) {
      if (now - at <= windowMs) live.add(listenerId);
      else debts.delete(listenerId);
    }

    // One reply settles the debt; a conversation that continues re-opens it
    // through the normal addressing path.
    this.#awaitingReply.delete(speakerId);
    return live;
  }

  async #refreshSettings(): Promise<void> {
    try {
      this.#settings = await getOfficeSettings(getDb());
    } catch (error: unknown) {
      logger.error('[office] could not read settings', error);
    }
  }

  // --- agent messages ------------------------------------------------------

  #agentSession(client: Client): AgentSession | null {
    const sim = this.#sims.get(client.sessionId);
    return sim?.agent ?? null;
  }

  #onAgentSay(client: Client, payload: AgentSayPayload): void {
    const session = this.#agentSession(client);
    const speaker = this.state.players.get(client.sessionId);
    if (!session || !speaker) return;

    const text = String(payload?.text ?? '').trim();
    audit(session.identity.id, 'command.say', { text });
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'chat')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "chat" scope.');
      return;
    }
    if (text.length === 0 || text.length > CHAT_MAX_LENGTH) {
      this.#denyAgent(
        client,
        session,
        'invalid_payload',
        `text must be 1..${CHAT_MAX_LENGTH} characters.`,
      );
      return;
    }

    const waitMs = allowChat(session, Date.now());
    if (waitMs > 0) {
      this.#denyAgent(client, session, 'rate_limited', 'Agents may speak once every 2s.', waitMs);
      return;
    }

    this.#deliverChat(client.sessionId, speaker, text);
    audit(session.identity.id, 'effect.spoke', { text, heardBy: this.#earshotCount(speaker) });
  }

  #onAgentMoveTo(client: Client, payload: AgentMoveToPayload): void {
    const session = this.#agentSession(client);
    if (!session) return;

    audit(session.identity.id, 'command.move_to', payload);
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'move')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "move" scope.');
      return;
    }

    const waitMs = allowMove(session, Date.now());
    if (waitMs > 0) {
      this.#denyAgent(client, session, 'rate_limited', 'Agents may move twice a second.', waitMs);
      return;
    }

    // TODO(step 0.8): private zones. Once zones carry access rules, an agent
    // routed into a `private` zone should be refused here with `unroutable`
    // unless its owner is inside. The hook is deliberately this one place.

    const routed =
      typeof payload?.zoneId === 'string'
        ? this.walkToZone(client.sessionId, payload.zoneId)
        : this.walkTo(client.sessionId, Number(payload?.x), Number(payload?.y));

    if (!routed) {
      this.#denyAgent(
        client,
        session,
        'unroutable',
        'No route to that destination, or it does not exist.',
      );
    }
  }

  #onAgentSetStatus(client: Client, payload: AgentSetStatusPayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const status = String(payload?.status ?? '').slice(0, AGENT_STATUS_MAX_LENGTH).trim();
    audit(session.identity.id, 'command.set_status', { status });
    markSeen(session.identity.id);

    if (!hasScope(session.identity, 'status')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "status" scope.');
      return;
    }

    if (player.status !== status) {
      player.status = status;
      session.identity.status = status;
      persistStatus(session.identity.id, status);
      audit(session.identity.id, 'effect.status_changed', { status });
      this.#broadcastRosterToAgents();
    }
  }

  /**
   * A harness describing the machine it runs on.
   *
   * Unscoped, because it changes nothing anybody else can see — it is the
   * agent telling its owner where it lives. It is still *untrusted*: an agent
   * key is a credential pasted into a config file, and everything here ends up
   * rendered on the owner's settings page, so `recordHost` normalises it and
   * drops runtime ids that aren't in the catalogue.
   */
  #onAgentHostReport(client: Client, payload: AgentHostReportPayload): void {
    const session = this.#agentSession(client);
    if (!session) return;

    markSeen(session.identity.id);
    const workspacePath = String(payload?.workspacePath ?? '');
    const rootedAtReposDir = Boolean(payload?.rootedAtReposDir);

    audit(session.identity.id, 'command.host_report', {
      label: payload?.label,
      workspacePath,
      rootedAtReposDir,
      runtimes: payload?.runtimes?.length ?? 0,
    });

    persistHostReport({
      agentId: session.identity.id,
      workspaceId: session.identity.workspaceId,
      ownerUserId: session.identity.ownerUserId,
      // The runtime list is passed through exactly as it arrived, including
      // absent: only the first agent of a fleet scans PATH, and `[]` from the
      // other seven would erase the answer seconds after getting it.
      report: {
        label: payload?.label,
        reposDir: payload?.reposDir,
        ...(payload?.runtimes ? { runtimes: payload.runtimes } : {}),
      },
      workspacePath,
      rootedAtReposDir,
    });
  }

  #onAgentLookAround(client: Client, payload: AgentLookAroundPayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    audit(session.identity.id, 'command.look_around', {});
    markSeen(session.identity.id);

    const tile = this.#tileOf(player);
    const zone = zoneAt(this.#map, tile.x, tile.y);
    const result: LookAroundResult = {
      zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
      tile,
      occupants: this.#occupantsAround(client.sessionId),
    };
    this.#reply(client, payload?.requestId, result);
  }

  #onAgentMessagesGet(client: Client, payload: AgentMessagesGetPayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const scope = payload?.scope === 'zone' ? 'zone' : 'nearby';
    const limit = Math.min(Math.max(Number(payload?.n) || MESSAGES_GET_MAX, 1), MESSAGES_GET_MAX);
    audit(session.identity.id, 'command.messages_get', { scope, n: limit });
    markSeen(session.identity.id);

    const tile = this.#tileOf(player);
    const myZone = zoneAt(this.#map, tile.x, tile.y)?.id ?? null;

    // Only what this agent could plausibly have heard. An agent must not be a
    // way to read the whole office from a corner of it.
    const matches = this.#chatLog.recent((message) => {
      if (scope === 'zone') return myZone !== null && message.zoneId === myZone;
      return (
        Math.hypot(message.x - player.x, message.y - player.y) / this.#map.tileSize <=
        this.#settings.chatRadiusTiles
      );
    }, limit);

    const result: MessagesGetResult = {
      scope,
      messages: matches.map((message) => ({
        from: message.from,
        fromUserId: message.fromUserId,
        fromName: message.fromName,
        fromKind: message.fromKind,
        text: message.text,
        distance: round(
          Math.hypot(message.x - player.x, message.y - player.y) / this.#map.tileSize,
        ),
        sentAt: message.sentAt,
      })),
    };
    this.#reply(client, payload?.requestId, result);
  }

  async #onAgentMemoryGet(client: Client, payload: AgentMemoryGetPayload): Promise<void> {
    const session = this.#agentSession(client);
    if (!session) return;

    const slug = String(payload?.slug ?? '');
    audit(session.identity.id, 'command.memory_get', { slug });
    markSeen(session.identity.id);

    try {
      const row = await getAgentMemory(getDb(), session.identity.id, slug);
      const result: MemoryGetResult = {
        slug,
        content: row?.content ?? '',
        updatedAt: row?.updatedAt ?? null,
        bytes: Buffer.byteLength(row?.content ?? '', 'utf8'),
        limitBytes: memoryLimitFor(slug),
      };
      this.#reply(client, payload?.requestId, result);
    } catch (error: unknown) {
      this.#replyError(client, payload?.requestId, this.#memoryError(error));
    }
  }

  async #onAgentMemorySet(client: Client, payload: AgentMemorySetPayload): Promise<void> {
    const session = this.#agentSession(client);
    if (!session) return;

    const slug = String(payload?.slug ?? '');
    const content = String(payload?.content ?? '');
    audit(session.identity.id, 'command.memory_set', {
      slug,
      bytes: Buffer.byteLength(content, 'utf8'),
    });
    markSeen(session.identity.id);

    try {
      const written = await setAgentMemory(getDb(), session.identity.id, slug, content);
      audit(session.identity.id, 'effect.memory_written', written);
      const result: MemorySetResult = { ...written, limitBytes: memoryLimitFor(slug) };
      this.#reply(client, payload?.requestId, result);
    } catch (error: unknown) {
      const failure = this.#memoryError(error);
      audit(session.identity.id, 'command.rejected', { command: 'memory_set', slug, ...failure });
      this.#replyError(client, payload?.requestId, failure);
    }
  }

  #memoryError(error: unknown): AgentErrorPayload {
    if (error instanceof MemoryLimitError) {
      return { code: 'too_large', message: error.message };
    }
    if (error instanceof MemorySlugError) {
      return { code: 'invalid_payload', message: error.message };
    }
    logger.error('[agent] memory operation failed', error);
    return { code: 'invalid_payload', message: 'Memory operation failed.' };
  }

  // --- outbound to agents --------------------------------------------------

  #occupantsAround(sessionId: string): AgentOccupant[] {
    const self = this.state.players.get(sessionId);
    if (!self) return [];

    const occupants: AgentOccupant[] = [];
    for (const [otherId, other] of this.state.players) {
      if (otherId === sessionId) continue;
      const tile = this.#tileOf(other);
      occupants.push({
        sessionId: otherId,
        userId: other.userId,
        name: other.name,
        kind: other.kind,
        status: other.status,
        distance: round(this.#tileDistance(self, other)),
        zoneId: zoneAt(this.#map, tile.x, tile.y)?.id ?? null,
      });
    }
    occupants.sort((a, b) => a.distance - b.distance);
    return occupants;
  }

  #sendRoster(sessionId: string): void {
    const client = this.clients.getById(sessionId);
    const player = this.state.players.get(sessionId);
    if (!client || !player) return;

    const tile = this.#tileOf(player);
    const zone: MapZone | null = zoneAt(this.#map, tile.x, tile.y);
    const event: AgentRosterEvent = {
      zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
      occupants: this.#occupantsAround(sessionId),
      at: Date.now(),
    };
    client.send(AgentServerMessage.Roster, event);
  }

  #broadcastRosterToAgents(): void {
    for (const sessionId of this.#agents.keys()) this.#sendRoster(sessionId);
  }

  #sendHeartbeats(): void {
    for (const sessionId of this.#agents.keys()) {
      const client = this.clients.getById(sessionId);
      const player = this.state.players.get(sessionId);
      if (!client || !player) continue;
      client.send(AgentServerMessage.Heartbeat, {
        serverTime: Date.now(),
        tile: this.#tileOf(player),
        moving: player.moving,
      });
    }
  }

  /**
   * Kick agents whose keys were revoked. Revocation happens in the web app,
   * which in development is a different process — so this polls rather than
   * listens, and an agent goes within AGENT_REVOCATION_POLL_MS rather than
   * instantly. The audit log records the kick, not just the revocation.
   */
  async #kickRevokedAgents(): Promise<void> {
    if (this.#agents.size === 0) return;

    const byAgentId = new Map<string, string>();
    for (const [sessionId, identity] of this.#agents) byAgentId.set(identity.id, sessionId);

    const revoked = await findRevoked([...byAgentId.keys()]);
    for (const agentId of revoked) {
      const sessionId = byAgentId.get(agentId);
      if (!sessionId) continue;

      audit(agentId, 'session.revoked', { sessionId, reason: 'key revoked' });
      logger.info(`[office] kicking revoked agent ${agentId} (${sessionId})`);

      const client = this.clients.getById(sessionId);
      client?.send(AgentServerMessage.Error, {
        code: 'missing_scope',
        message: 'This agent key has been revoked.',
      } satisfies AgentErrorPayload);
      // Consented close: no reconnection window for a revoked key.
      client?.leave(4000);
      this.#removePlayer(sessionId);
    }

    if (revoked.size > 0) this.#broadcastRosterToAgents();
  }

  #denyAgent(
    client: Client,
    session: AgentSession,
    code: AgentErrorPayload['code'],
    message: string,
    retryAfterMs?: number,
  ): void {
    audit(session.identity.id, 'command.rejected', { code, message });
    const payload: AgentErrorPayload = { code, message };
    if (retryAfterMs !== undefined) payload.retryAfterMs = Math.ceil(retryAfterMs);
    client.send(AgentServerMessage.Error, payload);
  }

  #reply(client: Client, requestId: unknown, data: unknown): void {
    if (typeof requestId !== 'string' || requestId.length === 0) return;
    client.send(AgentServerMessage.Result, {
      requestId,
      ok: true,
      data,
    } satisfies AgentResultPayload);
  }

  #replyError(client: Client, requestId: unknown, error: AgentErrorPayload): void {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      client.send(AgentServerMessage.Error, error);
      return;
    }
    client.send(AgentServerMessage.Result, {
      requestId,
      ok: false,
      error,
    } satisfies AgentResultPayload);
  }

  // --- helpers -------------------------------------------------------------

  /**
   * A free tile inside the agent_area zone, or the map's agent spawn.
   *
   * Agents are spaced out rather than packed in. Adjacent avatars overlap their
   * nameplates into an unreadable smear, and a nameplate you cannot read is a
   * legible worker you cannot identify — which is the entire point of them.
   */
  #agentSpawn(): TilePoint {
    const bay = this.#map.zones.find((zone) => zone.kind === 'agent_area');
    if (bay) {
      const occupied: TilePoint[] = [];
      for (const [, player] of this.state.players) occupied.push(this.#tileOf(player));

      const clearOf = (candidate: TilePoint, gap: number): boolean =>
        occupied.every(
          (tile) =>
            Math.max(Math.abs(tile.x - candidate.x), Math.abs(tile.y - candidate.y)) >= gap,
        );

      // Try for elbow room first, then settle for anywhere free.
      for (const gap of [AGENT_SPAWN_GAP_TILES, 1]) {
        for (let y = bay.bounds.y; y < bay.bounds.y + bay.bounds.height; y += 1) {
          for (let x = bay.bounds.x; x < bay.bounds.x + bay.bounds.width; x += 1) {
            const candidate = { x, y };
            if (!clearOf(candidate, gap)) continue;
            const free = nearestWalkable(this.#map, candidate, 0);
            if (free) return free;
          }
        }
      }
    }

    const spawn = spawnFor(this.#map, 'agent');
    return { x: spawn.x, y: spawn.y };
  }

  #earshotCount(speaker: OfficePlayer): number {
    let count = 0;
    for (const [, listener] of this.state.players) {
      if (listener === speaker) continue;
      if (this.#tileDistance(speaker, listener) <= this.#settings.chatRadiusTiles) count += 1;
    }
    return count;
  }

  #removePlayer(sessionId: string): void {
    this.state.players.delete(sessionId);
    this.#sims.delete(sessionId);
    this.#agents.delete(sessionId);
    this.#chatLimiter.forget(sessionId);
    this.#chatLog.forget(sessionId);
  }

  #tileOf(player: OfficePlayer): TilePoint {
    return {
      x: toTile(player.x, this.#map.tileSize),
      y: toTile(player.y, this.#map.tileSize),
    };
  }

  #tileDistance(a: OfficePlayer, b: OfficePlayer): number {
    return Math.hypot(a.x - b.x, a.y - b.y) / this.#map.tileSize;
  }

  #sendError(client: Client, code: ErrorPayload['code'], message: string): void {
    client.send(ServerMessage.Error, { code, message } satisfies ErrorPayload);
  }
}

function clampAxis(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-1, Math.min(1, parsed));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
