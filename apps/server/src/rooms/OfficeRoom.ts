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
  CHAT_LOG_LIMIT,
  CHANNEL_POST_MAX_LENGTH,
  CHAT_MAX_LENGTH,
  ClientMessage,
  DEFAULT_OFFICE_SETTINGS,
  EMOTE_TTL_DEFAULT_MS,
  EMOTE_TTL_MAX_MS,
  FLOOR_ZONE_ID,
  MESSAGES_GET_MAX,
  isEmote,
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
  messageMaxLength,
  zoneAt,
  type AgentChannelChatEvent,
  type AgentChannelsEvent,
  type AgentChatEvent,
  type AgentEmotePayload,
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
  mayAddToChannel,
  mayOpenDm,
  type ChannelActor,
  type ChannelChatPayload,
  type ChannelChatSendPayload,
  type ChannelJoinPayload,
  type ChannelLeavePayload,
  type ChannelRef,
  type ChannelSubject,
  type ChannelsPayload,
  type DmOpenPayload,
  type DmOpenedPayload,
  type FollowZonePayload,
  type MembershipRole,
  type ZoneChatPayload,
  type ChatBroadcastPayload,
  type ChatSendPayload,
  type Direction,
  type ErrorPayload,
  type HistoryGetPayload,
  type HistoryPayload,
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
  addChannelMember,
  channelMembershipForWorkspace,
  ensureZoneConversations,
  findAgentById,
  findMembership,
  getAgentMemory,
  listAgentsForWorkspace,
  listPeopleForWorkspace,
  removeChannelMember,
  getDb,
  getOfficeSettings,
  mentionsOf,
  openDm,
  recentMessages,
  recentMessagesNear,
  recordMessage,
  setAgentMemory,
  type AgentIdentity,
  type ChannelMember,
  type MessagePage,
  type StoredMessage,
} from '@quintal/shared/db';
import { loadOfficeMap } from '@quintal/shared/maps';
import { tileBeside } from '@quintal/shared';

import { agentBelongsToOffice, mayEnterOffice } from '../auth/office.js';

import {
  allowChat,
  allowEmote,
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

interface OfficeRoomOptions {
  mapId?: unknown;
  /**
   * Which office this room is. Routing only — `filterBy` puts callers asking
   * for the same value in the same room, and nothing more. It is not a
   * permission: a caller can ask for any workspace id it likes, so `onAuth`
   * proves the claim before anybody is let in.
   */
  workspaceId?: unknown;
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
      pubkey: string;
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
  /**
   * zoneId -> conversation id, for every zone on this map in this office.
   *
   * A promise because it is filled from the database when the room opens and
   * the first message can arrive before that returns. Anything that needs a
   * conversation awaits it; nothing else waits on it.
   */
  #conversations: Promise<ReadonlyMap<string, string>> = Promise.resolve(new Map());

  /**
   * Every channel in this office and who is in it, refreshed on the settings
   * cadence. Membership is changed from the settings page, in another
   * process in development, so this polls like everything else that is.
   */
  #channels: ReadonlyMap<string, ChannelRef & { members: ReadonlyMap<string, ChannelMember> }> =
    new Map();
  /** sessionId -> the channel list last sent to it, so a change is sent once. */
  readonly #channelsSent = new Map<string, string>();
  /**
   * sessionId -> the zone they are reading live from elsewhere. One per
   * person: a transcript you have open, not a wiretap on the office.
   */
  readonly #followed = new Map<string, string>();
  #nextEmoteSweep = 0;
  /** sessionId -> a balloon asked for inside the flicker interval, applied when it is up. */
  readonly #emoteLater = new Map<
    string,
    { timer: NodeJS.Timeout; wanted: { emote: string; ttlMs: number; chosen: boolean } }
  >();
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
    // Set here rather than on the first join: the room *is* one office, and its
    // settings are read before anybody has authenticated. `filterBy` guarantees
    // every later join carries the same value, and `onAuth` refuses one that
    // does not.
    this.#workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
    const mapId = typeof options.mapId === 'string' ? options.mapId : 'hq';
    this.#map = loadOfficeMap(mapId);

    const state = new OfficeState();
    state.mapId = mapId;
    this.state = state;

    this.#conversations = this.#openConversations(mapId);

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
    this.onMessage(ClientMessage.HistoryGet, (client, payload: HistoryGetPayload) =>
      void this.#onHistoryGet(client, payload),
    );
    this.onMessage(ClientMessage.ChannelChat, (client, payload: ChannelChatSendPayload) =>
      this.#onChannelChat(client, payload),
    );
    this.onMessage(ClientMessage.ChannelsGet, (client) => this.#sendChannels(client.sessionId));
    this.onMessage(ClientMessage.DmOpen, (client, payload: DmOpenPayload) =>
      void this.#onDmOpen(client, payload),
    );
    this.onMessage(ClientMessage.FollowZone, (client, payload: FollowZonePayload) =>
      this.#onFollowZone(client, payload),
    );
    this.onMessage(ClientMessage.ChannelJoin, (client, payload: ChannelJoinPayload) =>
      void this.#onChannelJoin(client, payload),
    );
    this.onMessage(ClientMessage.ChannelLeave, (client, payload: ChannelLeavePayload) =>
      void this.#onChannelLeave(client, payload),
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
    this.onMessage(AgentMessage.Emote, (client, payload: AgentEmotePayload) =>
      this.#onAgentEmote(client, payload),
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
    void this.#refreshChannels();
    this.#settingsTimer = setInterval(() => {
      void this.#refreshSettings();
      void this.#refreshChannels();
    }, 10_000);

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
  /**
   * The office this room belongs to, learned from the first join that created
   * it and identical for every later one — `filterBy` guarantees that.
   */
  #workspaceId = '';

  override async onAuth(_client: Client, options: OfficeRoomOptions): Promise<JoinAuth> {
    // An office is a workspace. One room per office, and nothing crosses:
    // agents belong to the office that defined them, people to the office they
    // are a member of. Before this, rooms were keyed by map alone, so every
    // workspace on a deployment shared one room — you could see, address and
    // talk to agents somebody else owned, in an office you had no part in.
    const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId : '';
    if (workspaceId.length === 0) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'No office was named in this join.');
    }
    // Belt and braces behind `filterBy`: if routing ever put two offices in one
    // room, this refuses rather than quietly merging them. Deliberately no
    // "adopt it if unset" fallback — the room's office is decided in `onCreate`,
    // and a line that took it from whoever joined first would let a claim
    // become the answer.
    if (workspaceId !== this.#workspaceId) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'That is not this office.');
    }

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
      if (!agentBelongsToOffice(identity, workspaceId)) {
        throw new ServerError(ErrorCode.AUTH_FAILED, 'That agent belongs to another office.');
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
      if (!agentBelongsToOffice(identity, workspaceId)) {
        throw new ServerError(ErrorCode.AUTH_FAILED, 'That agent belongs to another office.');
      }
      return { kind: 'agent', identity };
    }

    const user = await verifySessionToken(options.token);
    if (!user) {
      throw new ServerError(ErrorCode.AUTH_FAILED, 'No valid session. Sign in again.');
    }

    // A guest has no membership on purpose, so their one office is the one
    // their link was for. A member's is any they belong to. Either way the
    // claim is proved here, never taken from the join.
    if (!(await mayEnterOffice(user, workspaceId))) {
      throw new ServerError(
        ErrorCode.AUTH_FAILED,
        user.isGuest
          ? 'That guest link was for a different office.'
          : 'You are not a member of this office.',
      );
    }

    return {
      kind: 'human',
      userId: user.userId,
      name: displayNameFor(user),
      isGuest: user.isGuest,
      description: user.description,
      pubkey: user.pubkey,
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
        pubkey: auth.pubkey,
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
        description: identity.description,
        ownerName: identity.ownerName,
        ownerUserId: identity.ownerUserId,
        scopes: identity.scopes,
      }),
    );

    const session: AgentSession = { identity, lastChatAt: 0, lastMoveAt: 0, lastEmoteAt: 0 };
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
      description: identity.description,
      instructions: identity.instructions,
      ownerUserId: identity.ownerUserId,
      ownerName: identity.ownerName,
      scopes: identity.scopes,
      mapId: this.state.mapId,
      tile: spawn,
      zoneId: zone?.id ?? null,
      zones: this.#map.zones.map((z) => ({ id: z.id, label: z.label, kind: z.kind })),
      channels: this.#channelsFor(identity.id),
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
  /**
   * Walk to whoever this names, stopping beside them.
   *
   * Resolved here because the office is the only thing that knows where people
   * are. Matching is by display name and case-insensitive, the same rule
   * `@mentions` use — an agent told "come to Dpr010" should not have to care
   * about capitalisation any more than a person does.
   *
   * Tiles already claimed by somebody else are excluded, so two agents called
   * at once do not both aim at the same square.
   */
  walkToPerson(sessionId: string, name: string): boolean {
    const wanted = name.trim().toLowerCase();
    if (wanted.length === 0) return false;

    let target: { x: number; y: number } | null = null;
    const taken = new Set<string>();
    for (const [id, player] of this.state.players) {
      const tile = {
        x: Math.floor(player.x / this.#map.tileSize),
        y: Math.floor(player.y / this.#map.tileSize),
      };
      taken.add(`${tile.x},${tile.y}`);
      // Not the caller itself: an agent asked to come to somebody with its own
      // name would otherwise route to where it already stands and look stuck.
      if (id !== sessionId && player.name.trim().toLowerCase() === wanted) {
        target = tile;
      }
    }
    if (!target) return false;

    const beside = tileBeside(this.#map, target.x, target.y, taken);
    if (!beside) return false;
    return this.walkTo(sessionId, beside.x, beside.y);
  }

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

    // Once a second, not once a tick: a balloon's lifetime is seconds.
    const now = Date.now();
    if (now >= this.#nextEmoteSweep) {
      this.#nextEmoteSweep = now + 1_000;
      this.#sweepEmotes(now);
    }

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

    const text = this.#acceptHumanText(client, rawText);
    if (text === null) return;

    this.#deliverChat(client.sessionId, speaker, text);
  }

  #onChannelChat(client: Client, payload: ChannelChatSendPayload): void {
    const speaker = this.state.players.get(client.sessionId);
    if (!speaker) return;
    if (this.#sims.get(client.sessionId)?.agent) return; // agents post via agent:say

    const channel = this.#channelFor(speaker.userId, payload?.channelId);
    if (!channel) {
      this.#sendError(client, 'unauthorised', 'Not a channel you are in.');
      return;
    }

    const text = this.#acceptHumanText(client, payload?.text, CHANNEL_POST_MAX_LENGTH);
    if (text === null) return;

    this.#deliverChannelChat(client.sessionId, speaker, channel, text);
  }

  /**
   * Open a direct message with somebody, from the roster.
   *
   * The rule is `mayOpenDm`, and the facts it needs come from the database
   * rather than the room: the other party need not be in the room — you can
   * message an agent that is asleep, and it reads the line when it wakes.
   * The membership cache is refreshed at once rather than on the next poll,
   * so the tab appears when you click and not ten seconds later.
   */
  async #onDmOpen(client: Client, payload: DmOpenPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;

    const db = getDb();
    try {
      let memberId = String(payload?.memberId ?? '');
      // `/msg Marvin`: a name, resolved against everyone in the office —
      // present or not — and refused if it fits more than one of them, since
      // a display name is not an identity and a DM is not the place to guess.
      if (memberId.length === 0 && typeof payload?.name === 'string') {
        const wanted = payload.name.replace(/^@/, '').trim().toLowerCase();
        if (wanted.length === 0) return;
        const [people, agentsHere] = await Promise.all([
          listPeopleForWorkspace(db, this.#workspaceId),
          listAgentsForWorkspace(db, this.#workspaceId),
        ]);
        const matches = [
          ...people.filter((person) => person.name.toLowerCase() === wanted).map((p) => p.id),
          ...agentsHere
            .filter((agent) => agent.revokedAt === null && agent.name.toLowerCase() === wanted)
            .map((a) => a.id),
        ];
        if (matches.length !== 1) {
          this.#sendError(
            client,
            'invalid_message',
            matches.length === 0 ? `Nobody here called ${payload.name}.` : `More than one ${payload.name}.`,
          );
          return;
        }
        memberId = matches[0] ?? '';
      }
      if (memberId.length === 0) return;

      const actor = await this.#actorFor(player);

      let subject: ChannelSubject | null = null;
      const agent = await findAgentById(db, memberId);
      if (agent) {
        if (agent.workspaceId === this.#workspaceId && agent.revokedAt === null) {
          subject = {
            id: agent.id,
            kind: 'agent',
            ownerUserId: agent.ownerUserId,
            scopes: agent.scopes,
          };
        }
      } else if (await findMembership(db, memberId, this.#workspaceId)) {
        subject = { id: memberId, kind: 'human' };
      }

      if (!subject || !mayOpenDm(actor, subject)) {
        this.#sendError(client, 'unauthorised', 'You cannot message them.');
        return;
      }

      const { id } = await openDm(db, {
        workspaceId: this.#workspaceId,
        openerId: player.userId,
        other: { id: subject.id, kind: subject.kind },
      });
      await this.#refreshChannels();
      const channel = this.#channels.get(id);
      if (!channel) return;
      client.send(ServerMessage.DmOpened, {
        channel: this.#refFor(channel, player.userId),
      } satisfies DmOpenedPayload);
    } catch (error: unknown) {
      logger.error('[office] could not open a direct message', error);
    }
  }

  /**
   * Length and rate checks shared by everything a person can type. Null =
   * refused. Speech has the short cap; a channel post may run to a review.
   */
  #acceptHumanText(
    client: Client,
    rawText: unknown,
    maxLength: number = CHAT_MAX_LENGTH,
  ): string | null {
    const text = String(rawText ?? '').trim();
    if (text.length === 0) return null;

    if (text.length > maxLength) {
      this.#sendError(
        client,
        'invalid_message',
        `Messages are limited to ${maxLength} characters.`,
      );
      return null;
    }

    if (!this.#chatLimiter.tryConsume(client.sessionId)) {
      const retryAfter = this.#chatLimiter.retryAfterSeconds(client.sessionId);
      this.#sendError(client, 'rate_limited', `Slow down — try again in ${retryAfter}s.`);
      return null;
    }

    return text;
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
    const zoneId = zoneAt(this.#map, tile.x, tile.y)?.id ?? FLOOR_ZONE_ID;
    /** Stable ids of everyone this line addressed by name. */
    const mentioned: string[] = [];

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
      if (byName && listenerId !== sessionId) mentioned.push(listener.userId);
    }

    // Anyone reading this zone from elsewhere. Sent even to somebody who also
    // heard it in earshot: the two arrive on different messages and land in
    // different transcripts, and the client is the one that knows which it
    // has open. Deduplicating here would mean guessing that.
    for (const [followerId, followedZone] of this.#followed) {
      if (followedZone !== zoneId) continue;
      const follower = this.clients.getById(followerId);
      if (!follower) continue;
      follower.send(ServerMessage.ZoneChat, { zoneId, ...humanPayload } satisfies ZoneChatPayload);
    }

    // After delivery, not before: the people in the room should never wait on
    // a disk. A write that fails is logged and the words were still heard.
    void this.#keep(zoneId, {
      fromId: speaker.userId,
      fromKind: speaker.kind,
      fromName: speaker.name,
      text,
      sentAt,
      x: speaker.x,
      y: speaker.y,
      mentions: mentioned,
    });
  }

  // --- channels ------------------------------------------------------------

  async #refreshChannels(): Promise<void> {
    try {
      this.#channels = await channelMembershipForWorkspace(getDb(), this.#workspaceId);
    } catch (error: unknown) {
      logger.error('[office] could not read channels', error);
      return;
    }
    // Anyone whose list changed hears about it; anyone whose list did not, does not.
    for (const sessionId of this.state.players.keys()) this.#sendChannels(sessionId);
  }

  /** The channels and DMs one person or agent is in, as they should see them. */
  #channelsFor(memberId: string): ChannelRef[] {
    const mine: ChannelRef[] = [];
    for (const channel of this.#channels.values()) {
      if (channel.members.has(memberId)) mine.push(this.#refFor(channel, memberId));
    }
    return mine;
  }

  /**
   * A conversation as one member sees it. A channel looks the same to
   * everybody; a DM is named after the *other* party, so the same row is
   * "Marvin" to Josh and "Josh" to Marvin.
   */
  #refFor(
    channel: ChannelRef & { members: ReadonlyMap<string, ChannelMember> },
    viewerId: string,
  ): ChannelRef {
    if (channel.kind !== 'dm') {
      return { id: channel.id, kind: channel.kind, name: channel.name, slug: channel.slug };
    }
    let other = 'somebody';
    for (const member of channel.members.values()) {
      if (member.id !== viewerId) other = member.name;
    }
    return { id: channel.id, kind: 'dm', name: other, slug: '' };
  }

  /** A channel this member is in, by id — or null, which covers "no such channel" too. */
  #channelFor(memberId: string, channelId: unknown) {
    if (typeof channelId !== 'string' || channelId.length === 0) return null;
    const channel = this.#channels.get(channelId);
    return channel?.members.has(memberId) ? channel : null;
  }

  /**
   * Tell one client which channels it is in, if that changed since last time.
   *
   * Sent on request and on every refresh, but only when different: a list
   * that arrives every ten seconds unchanged is a list clients learn to
   * ignore, and then miss the one that matters.
   */
  #sendChannels(sessionId: string): void {
    const client = this.clients.getById(sessionId);
    const player = this.state.players.get(sessionId);
    if (!client || !player) return;

    const channels = this.#channelsFor(player.userId);
    // What a person could join: every channel they are not in. Never a DM —
    // there is no such thing as a DM you could join.
    const available: ChannelRef[] = [];
    if (!this.#agents.has(sessionId)) {
      for (const channel of this.#channels.values()) {
        if (channel.kind === 'channel' && !channel.members.has(player.userId)) {
          available.push(this.#refFor(channel, player.userId));
        }
      }
    }
    const signature = [...channels, ...available]
      .map((channel) => `${channel.id}:${channel.kind}:${channel.slug}:${channel.name}`)
      .join(',');
    if (this.#channelsSent.get(sessionId) === signature) return;
    this.#channelsSent.set(sessionId, signature);

    if (this.#agents.has(sessionId)) {
      client.send(AgentServerMessage.Channels, { channels } satisfies AgentChannelsEvent);
    } else {
      client.send(ServerMessage.Channels, { channels, available } satisfies ChannelsPayload);
    }
  }

  #onFollowZone(client: Client, payload: FollowZonePayload): void {
    if (this.#agents.has(client.sessionId)) return; // agents read zones with messages_get
    const zoneId = payload?.zoneId;
    if (typeof zoneId !== 'string' || zoneId.length === 0) {
      this.#followed.delete(client.sessionId);
      return;
    }
    const known = zoneId === FLOOR_ZONE_ID || this.#map.zones.some((zone) => zone.id === zoneId);
    if (!known) {
      this.#sendError(client, 'invalid_message', 'No such zone.');
      return;
    }
    this.#followed.set(client.sessionId, zoneId);
  }

  /** A person's standing in the office, for the channel rules. Null for a guest. */
  async #actorFor(player: OfficePlayer): Promise<ChannelActor> {
    const membership = player.isGuest
      ? null
      : await findMembership(getDb(), player.userId, this.#workspaceId);
    return {
      userId: player.userId,
      role: (membership?.role as MembershipRole | undefined) ?? null,
    };
  }

  /** `/join engineering`. Same rule as being added by somebody else: members only. */
  async #onChannelJoin(client: Client, payload: ChannelJoinPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;
    const slug = String(payload?.slug ?? '')
      .replace(/^#/, '')
      .trim()
      .toLowerCase();
    const channel = [...this.#channels.values()].find(
      (candidate) => candidate.kind === 'channel' && candidate.slug === slug,
    );
    if (!channel) {
      this.#sendError(client, 'invalid_message', `No #${slug} here.`);
      return;
    }
    try {
      const actor = await this.#actorFor(player);
      if (!mayAddToChannel(actor, { id: player.userId, kind: 'human' })) {
        this.#sendError(client, 'unauthorised', 'Guests cannot join channels.');
        return;
      }
      await addChannelMember(getDb(), {
        channelId: channel.id,
        memberId: player.userId,
        memberKind: 'human',
        addedBy: player.userId,
      });
      await this.#refreshChannels();
    } catch (error: unknown) {
      logger.error('[office] could not join a channel', error);
    }
  }

  /** `/leave`. Anyone may leave a channel; a DM is not left, only ignored. */
  async #onChannelLeave(client: Client, payload: ChannelLeavePayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.#agents.has(client.sessionId)) return;
    const channel = this.#channelFor(player.userId, payload?.channelId);
    if (!channel || channel.kind !== 'channel') return;
    try {
      await removeChannelMember(getDb(), channel.id, player.userId);
      await this.#refreshChannels();
    } catch (error: unknown) {
      logger.error('[office] could not leave a channel', error);
    }
  }

  /**
   * Post a line in a channel: every member in the room is told, wherever
   * they stand, and the line is kept for the members who are not.
   *
   * Not spatial, deliberately. No bubble, no earshot, no reply-debt — a
   * channel is a place you are in by membership, not by standing somewhere,
   * and mixing the two would make "who heard that" unanswerable.
   *
   * Agents are told whether the line named them. They wake for mentions and
   * for nothing else, but they are told everything, so the window their next
   * turn is given has the conversation the mention was part of.
   */
  #deliverChannelChat(
    sessionId: string,
    speaker: OfficePlayer,
    channel: ChannelRef & { members: ReadonlyMap<string, ChannelMember> },
    text: string,
  ): void {
    const sentAt = Date.now();

    // Mentions resolve against the channel's members, present or not: a
    // member who is not in the room right now can still be told later that
    // they were named, which is what the mention index is for. In a DM every
    // line is addressed to the other party by construction — there is nobody
    // else it could be for.
    const addressed = mentionedNames(text);
    const mentioned = new Set<string>();
    for (const member of channel.members.values()) {
      if (member.id === speaker.userId) continue;
      if (channel.kind === 'dm' || addressed.includes(member.name.toLowerCase())) {
        mentioned.add(member.id);
      }
    }

    const line = {
      from: sessionId,
      fromUserId: speaker.userId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt,
    };

    for (const [listenerId, listener] of this.state.players) {
      if (!channel.members.has(listener.userId)) continue;
      const target = this.clients.getById(listenerId);
      if (!target) continue;

      const ref = this.#refFor(channel, listener.userId);
      if (this.#agents.has(listenerId)) {
        target.send(AgentServerMessage.ChannelChat, {
          channel: ref,
          ...line,
          mentioned: mentioned.has(listener.userId),
        } satisfies AgentChannelChatEvent);
      } else {
        target.send(ServerMessage.ChannelChat, {
          channel: ref,
          from: line.from,
          fromName: line.fromName,
          fromKind: line.fromKind,
          text,
          sentAt,
        } satisfies ChannelChatPayload);
      }
    }

    void this.#keepIn(channel.id, {
      fromId: speaker.userId,
      fromKind: speaker.kind,
      fromName: speaker.name,
      text,
      sentAt,
      mentions: [...mentioned],
    });
  }

  // --- history -------------------------------------------------------------

  /**
   * Open this office's transcript for every zone on the map.
   *
   * A room that cannot reach the database still opens — people can talk, they
   * just are not being written down, and the log says so once rather than on
   * every line.
   */
  async #openConversations(mapId: string): Promise<ReadonlyMap<string, string>> {
    try {
      return await ensureZoneConversations(getDb(), this.#workspaceId, mapId, this.#map.zones);
    } catch (error: unknown) {
      logger.error('[office] could not open conversations; chat will not be kept', error);
      return new Map();
    }
  }

  async #keep(
    zoneId: string,
    message: Omit<Parameters<typeof recordMessage>[1], 'conversationId'>,
  ): Promise<void> {
    const conversationId = (await this.#conversations).get(zoneId);
    if (!conversationId) return;
    await this.#keepIn(conversationId, message);
  }

  async #keepIn(
    conversationId: string,
    message: Omit<Parameters<typeof recordMessage>[1], 'conversationId'>,
  ): Promise<void> {
    try {
      await recordMessage(getDb(), { conversationId, ...message });
    } catch (error: unknown) {
      logger.error('[office] could not keep a message', error);
    }
  }

  /** A zone id somebody sent, or the zone they stand in, or the floor. */
  #zoneIdFor(player: OfficePlayer, requested: unknown): string | null {
    if (typeof requested === 'string' && requested.length > 0) {
      if (requested === FLOOR_ZONE_ID) return requested;
      return this.#map.zones.some((zone) => zone.id === requested) ? requested : null;
    }
    const tile = this.#tileOf(player);
    return zoneAt(this.#map, tile.x, tile.y)?.id ?? FLOOR_ZONE_ID;
  }

  /**
   * What was said before somebody arrived.
   *
   * Two reads. With no zone named: what they could have heard from where they
   * stand, across zones — the first version read the transcript of the zone
   * they spawned in, which is the lobby, and the lobby is where nobody talks.
   * The box in the corner is an earshot box, and on arrival it should hold
   * what earshot would have held. With a zone named: that zone's transcript,
   * any zone in the office — a transcript is for the people who were not
   * there. Requested by the client once it is listening, because a message
   * sent from `onJoin` is sent to nobody.
   */
  async #onHistoryGet(client: Client, payload: HistoryGetPayload): Promise<void> {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const before = Number(payload?.before);
    const limit = Math.min(Math.max(Number(payload?.n) || CHAT_LOG_LIMIT, 1), CHAT_LOG_LIMIT);
    const paging = Number.isFinite(before) && before > 0 ? { before } : {};
    const workspaceId = this.#workspaceId;

    let zoneId: string | null = null;
    let channelId: string | null = null;
    let page: MessagePage;
    try {
      if (typeof payload?.channelId === 'string' && payload.channelId.length > 0) {
        const channel = this.#channelFor(player.userId, payload.channelId);
        if (!channel) {
          this.#sendError(client, 'unauthorised', 'Not a channel you are in.');
          return;
        }
        channelId = channel.id;
        page = await recentMessages(getDb(), channel.id, { workspaceId, limit, ...paging });
      } else if (typeof payload?.zoneId === 'string' && payload.zoneId.length > 0) {
        zoneId = this.#zoneIdFor(player, payload.zoneId);
        if (zoneId === null) {
          this.#sendError(client, 'invalid_message', 'No such zone.');
          return;
        }
        const conversationId = (await this.#conversations).get(zoneId);
        page = conversationId
          ? await recentMessages(getDb(), conversationId, { workspaceId, limit, ...paging })
          : { messages: [], hasMore: false };
      } else {
        page = await recentMessagesNear(getDb(), {
          workspaceId,
          mapId: this.state.mapId,
          x: player.x,
          y: player.y,
          radius: this.#settings.chatRadiusTiles * this.#map.tileSize,
          limit,
          ...paging,
        });
      }
      client.send(ServerMessage.History, {
        zoneId,
        channelId,
        hasMore: page.hasMore,
        messages: page.messages.map((message) => ({
          from: message.fromId,
          fromName: message.fromName,
          fromKind: message.fromKind,
          text: message.text,
          sentAt: message.sentAt,
        })),
      } satisfies HistoryPayload);
    } catch (error: unknown) {
      logger.error('[office] could not read history', error);
    }
  }

  #toChatEvent(message: StoredMessage, listener: OfficePlayer): AgentChatEvent {
    const distance =
      message.x === null || message.y === null
        ? 0
        : Math.hypot(message.x - listener.x, message.y - listener.y) / this.#map.tileSize;
    return {
      from: message.fromId,
      fromUserId: message.fromId,
      fromName: message.fromName,
      fromKind: message.fromKind,
      text: message.text,
      distance: round(distance),
      sentAt: message.sentAt,
    };
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
      this.#settings = await getOfficeSettings(getDb(), this.#workspaceId);
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
    // A post in a channel may be a whole review; speech stays a bubble.
    const maxLength = messageMaxLength(payload?.channelId);
    if (text.length === 0 || text.length > maxLength) {
      this.#denyAgent(
        client,
        session,
        'invalid_payload',
        `text must be 1..${maxLength} characters.`,
      );
      return;
    }

    const waitMs = allowChat(session, Date.now());
    if (waitMs > 0) {
      this.#denyAgent(client, session, 'rate_limited', 'Agents may speak once every 2s.', waitMs);
      return;
    }

    if (typeof payload?.channelId === 'string' && payload.channelId.length > 0) {
      const channel = this.#channelFor(speaker.userId, payload.channelId);
      if (!channel) {
        this.#denyAgent(client, session, 'not_found', 'Not a channel you are in.');
        return;
      }
      this.#deliverChannelChat(client.sessionId, speaker, channel, text);
      audit(session.identity.id, 'effect.posted', {
        text,
        kind: channel.kind,
        // A DM's slug is a pair key, not a name; the log gets the kind and
        // the conversation id, which is what "which DM" actually means.
        channel: channel.kind === 'dm' ? channel.id : channel.slug,
      });
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
        : typeof payload?.person === 'string'
          ? this.walkToPerson(client.sessionId, payload.person)
          : this.walkTo(client.sessionId, Number(payload?.x), Number(payload?.y));

    if (!routed) {
      this.#denyAgent(
        client,
        session,
        'unroutable',
        typeof payload?.person === 'string'
          ? `Nobody called "${payload.person}" is here, or there is nowhere to stand beside them.`
          : 'No route to that destination, or it does not exist.',
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

    // Where the work is. Only a conversation this agent is in — anything
    // else is an empty "spatial", never an error: a stale channel id must
    // not stop a status line from landing.
    const workingIn =
      status.length > 0 ? (this.#channelFor(player.userId, payload?.channelId)?.id ?? '') : '';
    if (player.workingIn !== workingIn) player.workingIn = workingIn;

    if (player.status !== status) {
      player.status = status;
      session.identity.status = status;
      persistStatus(session.identity.id, status);
      audit(session.identity.id, 'effect.status_changed', { status });
      this.#broadcastRosterToAgents();
    }
  }

  /**
   * A balloon over the head.
   *
   * Under the `status` scope — it is the status line in a glyph — and only
   * ever a catalogue id, because a balloon is a picture the office draws for
   * everybody and an agent does not get to draw arbitrary things. The office
   * owns the timer too: a balloon with a TTL comes down here, on the tick,
   * so a client that joined late agrees with one that saw it go up.
   */
  #onAgentEmote(client: Client, payload: AgentEmotePayload): void {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const emote = String(payload?.emote ?? '').trim();
    if (emote.length > 0 && !isEmote(emote)) {
      this.#denyAgent(client, session, 'invalid_payload', `"${emote}" is not an emote.`);
      return;
    }
    if (!hasScope(session.identity, 'status')) {
      this.#denyAgent(client, session, 'missing_scope', 'This agent has no "status" scope.');
      return;
    }

    const ttlRaw = payload?.ttlMs;
    const ttlMs =
      ttlRaw === undefined
        ? EMOTE_TTL_DEFAULT_MS
        : Math.min(Math.max(Number(ttlRaw) || 0, 0), EMOTE_TTL_MAX_MS);
    const wanted = { emote, ttlMs, chosen: ttlRaw === undefined };

    // A flicker guard, not a refusal. Balloons follow status lines, and a
    // tool-heavy turn flips those several times a second; refusing the extra
    // ones left the *last* balloon unset — the map showing a lightbulb on an
    // agent that had gone idle, with six "rate_limited" rows in its log. Now
    // the newest wanted balloon is kept and applied when the interval is up,
    // so the office always ends on the balloon the harness meant.
    const waitMs = allowEmote(session, Date.now());
    if (waitMs > 0) {
      const pending = this.#emoteLater.get(client.sessionId);
      if (pending) {
        pending.wanted = wanted;
        return;
      }
      const timer = setTimeout(() => {
        const later = this.#emoteLater.get(client.sessionId);
        this.#emoteLater.delete(client.sessionId);
        if (!later || !this.state.players.has(client.sessionId)) return;
        session.lastEmoteAt = Date.now();
        this.#applyEmote(client.sessionId, session, later.wanted);
      }, waitMs);
      this.#emoteLater.set(client.sessionId, { timer, wanted });
      return;
    }

    this.#applyEmote(client.sessionId, session, wanted);
  }

  #applyEmote(
    sessionId: string,
    session: AgentSession,
    wanted: { emote: string; ttlMs: number; chosen: boolean },
  ): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    const until = wanted.emote.length === 0 || wanted.ttlMs === 0 ? 0 : Date.now() + wanted.ttlMs;
    if (player.emote !== wanted.emote) player.emote = wanted.emote;
    if (player.emoteUntil !== until) player.emoteUntil = until;
    // Only the chosen ones are worth a log line; the derived ones follow the
    // status changes that are already logged.
    if (wanted.chosen && wanted.emote.length > 0) {
      audit(session.identity.id, 'command.emote', { emote: wanted.emote });
    }
  }

  /** Bring down balloons whose time is up. Called from the tick, once a second. */
  #sweepEmotes(now: number): void {
    for (const player of this.state.players.values()) {
      if (player.emoteUntil !== 0 && player.emoteUntil <= now) {
        player.emote = '';
        player.emoteUntil = 0;
      }
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

  /**
   * Read what was said.
   *
   * This used to be limited to what the agent could plausibly have heard, on
   * the grounds that an agent must not be a way to read the office from a
   * corner of it. Now that a transcript is kept and any member can open any
   * zone's, that limit protected nothing a person could not already do — so
   * an agent reads by the same rule a person does. Private zones will gate
   * both alike when they gate anything.
   */
  async #onAgentMessagesGet(client: Client, payload: AgentMessagesGetPayload): Promise<void> {
    const session = this.#agentSession(client);
    const player = this.state.players.get(client.sessionId);
    if (!session || !player) return;

    const scope =
      payload?.scope === 'zone' || payload?.scope === 'mentions' || payload?.scope === 'channel'
        ? payload.scope
        : 'nearby';
    const limit = Math.min(Math.max(Number(payload?.n) || MESSAGES_GET_MAX, 1), MESSAGES_GET_MAX);
    const before = Number(payload?.before);
    const paging = Number.isFinite(before) && before > 0 ? { before } : {};
    audit(session.identity.id, 'command.messages_get', { scope, n: limit });
    markSeen(session.identity.id);

    const db = getDb();
    const workspaceId = this.#workspaceId;
    let zoneId: string | null = null;
    let channelId: string | null = null;
    let page: MessagePage;
    try {
      if (scope === 'mentions') {
        page = await mentionsOf(db, session.identity.id, { workspaceId, limit, ...paging });
      } else if (scope === 'channel') {
        const channel = this.#channelFor(session.identity.id, payload?.channelId);
        if (!channel) {
          this.#replyError(client, payload?.requestId, {
            code: 'not_found',
            message: 'Not a channel you are in.',
          });
          return;
        }
        channelId = channel.id;
        page = await recentMessages(db, channel.id, { workspaceId, limit, ...paging });
      } else if (scope === 'zone') {
        zoneId = this.#zoneIdFor(player, payload?.zoneId);
        if (zoneId === null) {
          this.#replyError(client, payload?.requestId, {
            code: 'not_found',
            message: 'No such zone.',
          });
          return;
        }
        const conversationId = (await this.#conversations).get(zoneId);
        page = conversationId
          ? await recentMessages(db, conversationId, { workspaceId, limit, ...paging })
          : { messages: [], hasMore: false };
      } else {
        page = await recentMessagesNear(db, {
          workspaceId,
          mapId: this.state.mapId,
          x: player.x,
          y: player.y,
          radius: this.#settings.chatRadiusTiles * this.#map.tileSize,
          limit,
          ...paging,
        });
      }
    } catch (error: unknown) {
      logger.error('[office] could not read messages', error);
      this.#replyError(client, payload?.requestId, {
        code: 'unavailable',
        message: 'Could not read messages.',
      });
      return;
    }

    const result: MessagesGetResult = {
      scope,
      zoneId,
      channelId,
      hasMore: page.hasMore,
      messages: page.messages.map((message) => this.#toChatEvent(message, player)),
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
      const row = await getAgentMemory(getDb(), session.identity.id, this.#workspaceId, slug);
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
    this.#channelsSent.delete(sessionId);
    this.#followed.delete(sessionId);
    const later = this.#emoteLater.get(sessionId);
    if (later) {
      clearTimeout(later.timer);
      this.#emoteLater.delete(sessionId);
    }
    // Nothing about what they said is forgotten. It used to be: leaving the
    // room erased your lines from everybody else's history.
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
