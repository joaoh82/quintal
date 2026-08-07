import { Room, type Client, logger } from '@colyseus/core';
import {
  CHAT_MAX_LENGTH,
  CHAT_RADIUS_TILES,
  ClientMessage,
  OfficePlayer,
  OfficeState,
  RECONNECTION_SECONDS,
  ServerMessage,
  TICK_MS,
  createPlayer,
  directionFromIntent,
  findPath,
  followPath,
  nearestWalkable,
  normalize,
  spawnFor,
  stepMovement,
  tileCentre,
  toTile,
  type ChatBroadcastPayload,
  type ChatSendPayload,
  type Direction,
  type ErrorPayload,
  type InputPayload,
  type MoveIntent,
  type OfficeMap,
  type StatusPayload,
  type TilePoint,
  type WalkToPayload,
} from '@quintal/shared';
import { loadOfficeMap } from '@quintal/shared/maps';

import { displayNameFor, verifySessionToken } from '../auth/session.js';
import { ChatRateLimiter } from './chat-limiter.js';

interface OfficeRoomOptions {
  mapId?: unknown;
  token?: unknown;
}

interface JoinAuth {
  userId: string;
  name: string;
}

/**
 * Per-session simulation data the clients never see. Intents and routes are
 * inputs to the simulation, not state to replicate — clients get positions.
 */
interface PlayerSim {
  intent: MoveIntent;
  path: TilePoint[];
  /** Set while the client is disconnected but inside its reconnection window. */
  away: boolean;
}

const STATUS_MAX_LENGTH = 60;

/**
 * The office.
 *
 * Authoritative: clients send *intent* (a direction, or a tile to walk to) and
 * the server decides where anybody actually is. A client that lies about its
 * position has nothing to lie with — position never travels client-to-server.
 *
 * Everyone joins as `kind: "human"` today. Agents arrive through this same
 * room next step, so every path below reads `kind` rather than assuming.
 */
export class OfficeRoom extends Room<OfficeState> {
  override maxClients = 64;

  #map!: OfficeMap;
  readonly #sims = new Map<string, PlayerSim>();
  readonly #chatLimiter = new ChatRateLimiter();

  override onCreate(options: OfficeRoomOptions): void {
    const mapId = typeof options.mapId === 'string' ? options.mapId : 'hq';

    // Throws on an unknown map, which fails room creation — better than
    // silently dropping everyone into a default office.
    this.#map = loadOfficeMap(mapId);

    const state = new OfficeState();
    state.mapId = mapId;
    this.state = state;

    this.setPatchRate(TICK_MS);
    this.setSimulationInterval((deltaMs) => this.#tick(deltaMs), TICK_MS);

    this.onMessage(ClientMessage.Input, (client, payload: InputPayload) =>
      this.#onInput(client, payload),
    );
    this.onMessage(ClientMessage.WalkTo, (client, payload: WalkToPayload) =>
      this.#onWalkTo(client, payload),
    );
    this.onMessage(ClientMessage.Chat, (client, payload: ChatSendPayload) =>
      this.#onChat(client, payload),
    );
    this.onMessage(ClientMessage.SetStatus, (client, payload: StatusPayload) =>
      this.#onStatus(client, payload),
    );

    logger.info(`[office] room ${this.roomId} created on map "${mapId}"`);
  }

  /**
   * Verify the Better Auth session before the client is allowed in. Throwing
   * here rejects the join; the client sees a 4xx and never enters the room.
   */
  override async onAuth(_client: Client, options: OfficeRoomOptions): Promise<JoinAuth> {
    const user = await verifySessionToken(options.token);
    if (!user) throw new Error('unauthorised: no valid session');
    return { userId: user.userId, name: displayNameFor(user) };
  }

  override onJoin(client: Client, _options: OfficeRoomOptions, auth: JoinAuth): void {
    const spawn = spawnFor(this.#map, 'human');
    const player = createPlayer({
      userId: auth.userId,
      name: auth.name,
      x: tileCentre(spawn.x, this.#map.tileSize),
      y: tileCentre(spawn.y, this.#map.tileSize),
      kind: 'human',
    });

    this.state.players.set(client.sessionId, player);
    this.#sims.set(client.sessionId, { intent: { x: 0, y: 0 }, path: [], away: false });

    logger.info(`[office] ${auth.name} (${client.sessionId}) joined ${this.roomId}`);
  }

  /**
   * A dropped client keeps its avatar standing in the room for
   * RECONNECTION_SECONDS. Closing a laptop lid shouldn't delete you from the
   * office — and it shouldn't make you reappear at spawn either.
   */
  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const sim = this.#sims.get(client.sessionId);
    const player = this.state.players.get(client.sessionId);

    if (consented === true || !player || !sim) {
      this.#removePlayer(client.sessionId);
      return;
    }

    // Stop dead where they stood, and let everyone see why.
    sim.intent = { x: 0, y: 0 };
    sim.path = [];
    sim.away = true;
    player.moving = false;
    player.status = 'away';

    try {
      await this.allowReconnection(client, RECONNECTION_SECONDS);
      sim.away = false;
      player.status = '';
      logger.info(`[office] ${client.sessionId} reconnected to ${this.roomId}`);
    } catch {
      this.#removePlayer(client.sessionId);
      logger.info(`[office] ${client.sessionId} did not come back`);
    }
  }

  override onDispose(): void {
    logger.info(`[office] room ${this.roomId} disposed`);
  }

  // --- public API ----------------------------------------------------------

  /**
   * Route a player to a tile, server-side. Humans reach this through
   * click-to-move; agents will call it directly via `move_to` next step, which
   * is why it takes a session id rather than a client.
   *
   * Returns false when there is no route — the caller decides whether that's
   * worth telling anyone about.
   */
  walkTo(sessionId: string, tileX: number, tileY: number): boolean {
    const player = this.state.players.get(sessionId);
    const sim = this.#sims.get(sessionId);
    if (!player || !sim || sim.away) return false;

    const goal = nearestWalkable(this.#map, { x: Math.trunc(tileX), y: Math.trunc(tileY) });
    if (!goal) return false;

    const from = this.#tileOf(player);
    const path = findPath(this.#map, from, goal);
    if (path.length === 0) return false;

    sim.intent = { x: 0, y: 0 };
    sim.path = path;
    return true;
  }

  // --- simulation ----------------------------------------------------------

  #tick(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    for (const [sessionId, sim] of this.#sims) {
      const player = this.state.players.get(sessionId);
      if (!player || sim.away) continue;

      if (sim.intent.x !== 0 || sim.intent.y !== 0) {
        this.#stepWithIntent(player, sim, deltaSeconds);
      } else if (sim.path.length > 0) {
        this.#stepAlongPath(player, sim, deltaSeconds);
      } else if (player.moving) {
        player.moving = false;
      }
    }
  }

  #stepWithIntent(player: OfficePlayer, sim: PlayerSim, deltaSeconds: number): void {
    const next = stepMovement(this.#map, player, sim.intent, deltaSeconds);
    this.#apply(player, next.x, next.y, directionFromIntent(sim.intent, player.dir), true);
  }

  #stepAlongPath(player: OfficePlayer, sim: PlayerSim, deltaSeconds: number): void {
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
  }

  /** Write to state only where something actually changed. */
  #apply(
    player: OfficePlayer,
    x: number,
    y: number,
    dir: Direction,
    moving: boolean,
  ): void {
    if (player.x !== x) player.x = x;
    if (player.y !== y) player.y = y;
    if (player.dir !== dir) player.dir = dir;
    if (player.moving !== moving) player.moving = moving;
  }

  // --- messages ------------------------------------------------------------

  #onInput(client: Client, payload: InputPayload): void {
    const sim = this.#sims.get(client.sessionId);
    if (!sim || sim.away) return;

    const intent = normalize({
      x: clampAxis(payload?.x),
      y: clampAxis(payload?.y),
    });

    sim.intent = intent;
    // Touching the keys abandons a click-to-move route: the last thing the
    // player did wins.
    if (intent.x !== 0 || intent.y !== 0) sim.path = [];
  }

  #onWalkTo(client: Client, payload: WalkToPayload): void {
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.#sendError(client, 'invalid_move', 'Target must be a tile coordinate.');
      return;
    }
    this.walkTo(client.sessionId, x, y);
  }

  #onStatus(client: Client, payload: StatusPayload): void {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const status = String(payload?.status ?? '').slice(0, STATUS_MAX_LENGTH).trim();
    if (player.status !== status) player.status = status;
  }

  #onChat(client: Client, payload: ChatSendPayload): void {
    const speaker = this.state.players.get(client.sessionId);
    if (!speaker) return;

    const text = String(payload?.text ?? '').trim();
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
      this.#sendError(
        client,
        'rate_limited',
        `Slow down — try again in ${retryAfter}s.`,
      );
      return;
    }

    const message: ChatBroadcastPayload = {
      from: client.sessionId,
      fromName: speaker.name,
      fromKind: speaker.kind,
      text,
      sentAt: Date.now(),
    };

    // Proximity, not broadcast: the office is a place, and you hear the people
    // standing near you. Agents will speak through exactly this path.
    for (const [sessionId, listener] of this.state.players) {
      if (this.#tileDistance(speaker, listener) > CHAT_RADIUS_TILES) continue;
      const target = this.clients.getById(sessionId);
      target?.send(ServerMessage.Chat, message);
    }
  }

  // --- helpers -------------------------------------------------------------

  #removePlayer(sessionId: string): void {
    this.state.players.delete(sessionId);
    this.#sims.delete(sessionId);
    this.#chatLimiter.forget(sessionId);
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
    const payload: ErrorPayload = { code, message };
    client.send(ServerMessage.Error, payload);
  }
}

function clampAxis(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-1, Math.min(1, parsed));
}
