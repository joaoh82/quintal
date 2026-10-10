import {
  ClientMessage,
  ServerMessage,
  activityTerminal,
  agentTaskOf,
  directionFromIntent,
  findPath,
  followPath,
  nearestWalkable,
  normalize,
  parseTiledMap,
  stepMovement,
  tileCentre,
  toTile,
  zoneAt,
  FLOOR_ZONE_ID,
  type ChannelChatPayload,
  type ChannelChatSendPayload,
  type ChannelJoinPayload,
  type ChannelLeavePayload,
  type ReadPayload,
  type ChannelsPayload,
  type FollowZonePayload,
  type ZoneChatPayload,
  type ChatBroadcastPayload,
  type Direction,
  type DmOpenPayload,
  type DmOpenedPayload,
  type EarshotPayload,
  type ErrorPayload,
  type NoticePayload,
  type GameBridge,
  type HistoryGetPayload,
  type HistoryPayload,
  type InputPayload,
  type WalkToPayload,
  type MapZone,
  type MoveIntent,
  type OfficeMap,
  type OfficePlayer,
  type OfficeState,
  type RosterEntry,
  type TilePoint,
  type TiledMap,
} from '@quintal/shared';
import { getStateCallbacks, type Room } from 'colyseus.js';
// Namespace import, not default: Phaser's ESM build (`module` entry, which is
// what the bundler picks) has no default export, and webpack warns on every
// build if you ask for one.
import * as Phaser from 'phaser';

import { Avatar } from '../avatar';
import { canSettle, settle, type Authority } from '../reconcile';
import { Speech } from '../speech';
import {
  ASSETS,
  BODY_FRAME,
  BODY_IDS,
  BODY_ROW,
  BODY_TIMING,
  CAMERA_LERP,
  CAMERA_ZOOM,
  DEPTH,
  EMOTE_SIZE,
  DEBUG_COLORS,
  PATHS,
  PROP_ATLASES,
  bodyAnimation,
  bodyFrames,
  bodyPath,
  bodyTexture,
  isPropAtlasKey,
  propAtlasPath,
  type BodyState,
} from '../constants';

interface OfficeSceneData {
  bridge: GameBridge;
  room: Room<OfficeState>;
}

/**
 * The office, now with other people in it.
 *
 * Authority lives on the server. This scene predicts the local player's
 * movement so the keys feel instant, then corrects itself against the patches
 * that come back. Remote players are interpolated a fraction of a second behind
 * real time so their motion is smooth rather than accurate — see `Avatar`.
 */
export class OfficeScene extends Phaser.Scene {
  static readonly KEY = 'office';

  #bridge!: GameBridge;
  #room!: Room<OfficeState>;
  #map!: OfficeMap;

  #cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  #wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;
  /** Set while the chat box has focus: the office must not eat the typing. */
  #inputCaptured = false;

  readonly #avatars = new Map<string, Avatar>();
  #selfId = '';
  #self: Avatar | null = null;

  /** Where we think we are. Corrected by, not replaced by, the server. */
  #predicted = { x: 0, y: 0 };
  /** What the server last said about us; settled onto once it is current. */
  #authority: Authority | null = null;
  /** Count of movement commands sent, keyboard and click alike. */
  #moveSeq = 0;
  #intent: MoveIntent = { x: 0, y: 0 };
  #sentIntent: MoveIntent = { x: 0, y: 0 };
  #facing: Direction = 'down';
  /** Local mirror of the click-to-move route, predicted alongside the server. */
  #path: TilePoint[] = [];

  #currentZone: MapZone | null = null;
  #currentTile: TilePoint = { x: -1, y: -1 };
  /** Signature of the last roster we published, to avoid pointless re-renders. */
  #rosterSignature = '';
  #nextMinimapAt = 0;
  /** When each occupant was last seen doing something. Drives "last action". */
  readonly #lastAction = new Map<string, number>();

  /** Turns an agent's public activity back into a bubble over its head. */
  readonly #speech = new Speech();

  #debugEnabled = false;
  #debugStatic!: Phaser.GameObjects.Graphics;
  #debugPath!: Phaser.GameObjects.Graphics;

  constructor() {
    super(OfficeScene.KEY);
  }

  init(data: OfficeSceneData): void {
    this.#bridge = data.bridge;
    this.#room = data.room;
  }

  preload(): void {
    this.load.image(ASSETS.surfaces, PATHS.surfaces);
    this.load.image(ASSETS.walls, PATHS.walls);
    this.load.tilemapTiledJSON(ASSETS.map, PATHS.map);
    this.load.spritesheet(ASSETS.emotes, PATHS.emotes, {
      frameWidth: EMOTE_SIZE,
      frameHeight: EMOTE_SIZE,
    });

    for (const key of Object.keys(PROP_ATLASES)) {
      const paths = propAtlasPath(key as keyof typeof PROP_ATLASES);
      this.load.atlas(`props-${key}`, paths.texture, paths.atlas);
    }

    // Every body, not only the ones currently in the room: somebody joining
    // must not appear as a blank rectangle while their sheet is fetched. Twelve
    // sheets is 450KB, which is worth paying once at load for a room where
    // nobody pops in as a blank rectangle.
    for (const body of BODY_IDS) {
      this.load.spritesheet(bodyTexture(body), bodyPath(body), {
        frameWidth: BODY_FRAME.width,
        frameHeight: BODY_FRAME.height,
      });
    }
  }

  create(): void {
    const tilemap = this.make.tilemap({ key: ASSETS.map });
    const surfaces = tilemap.addTilesetImage('surfaces', ASSETS.surfaces);
    const walls = tilemap.addTilesetImage('walls', ASSETS.walls);
    if (!surfaces || !walls) throw new Error('Tileset images failed to attach to the tilemap');

    // The same parser the server runs, over the same file. Prediction can only
    // agree with authority if both are walking the same grid.
    this.#map = parseTiledMap(this.cache.tilemap.get(ASSETS.map).data as TiledMap);

    // `collision` is drawn from the wall image but never shown: it is the
    // authored footprint of the furniture, which is sprites on an object layer
    // rather than tiles. Creating it anyway keeps the Z overlay honest — what
    // it paints red is the layer the server actually blocks on.
    for (const [name, depth] of [
      ['floor', DEPTH.floor],
      ['walls', DEPTH.walls],
    ] as const) {
      const layer = tilemap.createLayer(name, [surfaces, walls], 0, 0);
      if (!layer) throw new Error(`Map is missing the "${name}" layer`);
      layer.setDepth(depth);
    }
    if (!tilemap.getLayer('collision')) throw new Error('Map is missing the "collision" layer');

    this.#createProps(tilemap);
    this.#createAnimations();
    this.#zoneLabels();
    this.#debugStatic = this.add.graphics().setDepth(DEPTH.debug).setVisible(false);
    this.#debugPath = this.add.graphics().setDepth(DEPTH.debug + 1).setVisible(false);

    const world = { width: tilemap.widthInPixels, height: tilemap.heightInPixels };
    this.cameras.main.setBounds(0, 0, world.width, world.height);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.roundPixels = true;

    this.#bindInput();
    this.#bindRoom();

    this.#bridge.emit('minimapMap', this.#map);
    this.#bridge.emit('ready', {
      mapName: this.#map.name,
      width: this.#map.width,
      height: this.#map.height,
      zones: this.#map.zones,
    });
  }

  override update(time: number, deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    this.#readKeyboard();
    this.#predict(deltaSeconds);
    this.#settle(deltaSeconds);

    const now = performance.now();
    for (const avatar of this.#avatars.values()) {
      if (avatar !== this.#self) avatar.interpolate(now);
      avatar.tickBubble(now);
      avatar.tickEmote(now);
    }

    this.#publishTile();
    if (time >= this.#nextMinimapAt) {
      this.#nextMinimapAt = time + 200;
      this.#publishMinimap();
    }
    if (this.#debugEnabled) this.#drawDebugPath();
  }

  #publishMinimap(): void {
    const size = this.#map.tileSize;
    const view = this.cameras.main.worldView;
    const players: import('@quintal/shared').GameEvents['minimap']['players'] = [];
    for (const [sessionId, avatar] of this.#avatars) {
      const player = this.#room.state.players.get(sessionId);
      if (!player) continue;
      players.push({
        sessionId,
        name: player.name,
        kind: player.kind,
        isSelf: sessionId === this.#selfId,
        x: avatar.sprite.x / size,
        y: avatar.sprite.y / size,
      });
    }
    // Draw self last, so nearby occupants cannot cover the local marker.
    players.sort((a, b) => Number(a.isSelf) - Number(b.isSelf));
    this.#bridge.emit('minimap', {
      viewport: { x: view.x / size, y: view.y / size, width: view.width / size, height: view.height / size },
      players,
    });
  }

  // --- room ----------------------------------------------------------------

  #bindRoom(): void {
    const room = this.#room;

    room.onMessage(ServerMessage.Chat, (message: ChatBroadcastPayload) => {
      this.#avatars.get(message.from)?.say(message.text);
      this.#bridge.emit('chat', message);
    });

    room.onMessage(ServerMessage.Error, (error: ErrorPayload) => {
      this.#bridge.emit('notice', {
        code: error.code,
        message: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
    });
    // Not a refusal: the line went out, and here is what it could not do.
    room.onMessage(ServerMessage.Notice, (notice: NoticePayload) => {
      this.#bridge.emit('notice', { code: notice.code, message: notice.message });
    });

    room.onMessage('activity', (activity: import('@quintal/shared').PublicActivity) => {
      this.#speakActivity(activity);
      this.#bridge.emit('activity', activity);
    });
    room.onMessage(
      ServerMessage.Approval,
      (approval: import('@quintal/shared').PublicApprovalRequest) => {
        this.#bridge.emit('approval', approval);
      },
    );
    room.onMessage(
      ServerMessage.ApprovalResolved,
      (resolved: import('@quintal/shared').PublicApprovalResolved) => {
        this.#bridge.emit('approvalResolved', resolved);
      },
    );
    room.onMessage(ServerMessage.History, (history: HistoryPayload) => {
      this.#bridge.emit('history', history);
    });
    room.onMessage(ServerMessage.ChannelChat, (message: ChannelChatPayload) => {
      // No bubble: a channel is not a place on the map.
      this.#bridge.emit('channelChat', message);
    });
    room.onMessage(ServerMessage.Channels, (channels: ChannelsPayload) => {
      this.#bridge.emit('channels', channels);
    });
    room.onMessage(ServerMessage.DmOpened, (opened: DmOpenedPayload) => {
      this.#bridge.emit('dmOpened', opened);
    });
    room.onMessage(ServerMessage.ZoneChat, (message: ZoneChatPayload) => {
      this.#bridge.emit('zoneChat', message);
    });
    room.onMessage(ServerMessage.Earshot, (earshot: EarshotPayload) => {
      this.#bridge.emit('earshot', earshot);
    });
    // Asked for here, after the handlers exist, and not pushed by the server on
    // join — a message sent before anybody is listening is sent to nobody.
    room.send(ClientMessage.HistoryGet, {});
    room.send(ClientMessage.ChannelsGet, {});
    room.send(ClientMessage.EarshotGet, {});

    // Schema callbacks go through a proxy in 0.16 rather than living on the
    // schema instances themselves.
    const $ = getStateCallbacks(room);

    $(room.state).players.onAdd((player: OfficePlayer, sessionId: string) => {
      const isSelf = sessionId === room.sessionId;
      const avatar = new Avatar(this, sessionId, player, isSelf);
      this.#avatars.set(sessionId, avatar);

      if (isSelf) {
        this.#self = avatar;
        this.#selfId = sessionId;
        this.#predicted = { x: player.x, y: player.y };
        this.#authority = null;
        this.#facing = player.dir;
        avatar.setPosition(player.x, player.y);
        this.cameras.main.centerOn(player.x, player.y);
        this.cameras.main.startFollow(avatar.sprite, true, CAMERA_LERP, CAMERA_LERP);
      }

      // Colyseus fires onAdd for players already present at join, so this also
      // covers the initial roster.
      $(player).onChange(() => this.#onPlayerChange(sessionId, player));
      this.#publishRoster();
    });

    $(room.state).players.onRemove((_player: OfficePlayer, sessionId: string) => {
      this.#avatars.get(sessionId)?.destroy();
      this.#avatars.delete(sessionId);
      this.#lastAction.delete(sessionId);
      this.#publishRoster();
    });
  }

  /**
   * Put an agent's line over its head, if anybody here can hear it.
   *
   * Who can hear it is the office's decision, not this one: `nearby` is set
   * per client from earshot, so all this does is draw. See `Speech` for why
   * the bubble comes from the activity rather than from a chat message — in
   * short, the activity is already the transcript, and saying it twice would
   * write it twice.
   */
  #speakActivity(activity: import('@quintal/shared').PublicActivity): void {
    const said = this.#speech.next(activity);
    if (activityTerminal(activity.state)) this.#speech.forget(activity.turnId);
    if (!said) return;

    for (const [sessionId, player] of this.#room.state.players) {
      if (player.kind !== 'agent' || player.userId !== said.agentId) continue;
      this.#avatars.get(sessionId)?.say(said.text);
      return;
    }
  }

  #onPlayerChange(sessionId: string, player: OfficePlayer): void {
    const avatar = this.#avatars.get(sessionId);
    if (!avatar) return;

    if (sessionId === this.#selfId) {
      this.#reconcile(player);
    } else {
      avatar.pushSnapshot(player);
    }

    // "Last action" means something a person would notice, not every patch.
    // An idle wander is the office moving the avatar, not the agent acting:
    // the roster keeps saying "idle" rather than "now".
    if ((player.moving && !player.idle) || player.status !== avatar.lastStatus) {
      this.#lastAction.set(sessionId, Date.now());
      avatar.lastStatus = player.status;
    }

    // onChange fires for every field on every patch — 20Hz per player. Only
    // the roster's own fields are worth waking React for; position is not.
    this.#publishRoster();
  }

  /**
   * Note what the server says about us. Acting on it is `#settle`'s job, and
   * waits until it describes the present rather than a round trip ago.
   */
  #reconcile(player: OfficePlayer): void {
    this.#authority = { x: player.x, y: player.y, moving: player.moving, seq: player.inputSeq };
  }

  // --- local prediction ----------------------------------------------------

  #predict(deltaSeconds: number): void {
    const self = this.#self;
    if (!self) return;

    let moving = false;

    if (this.#intent.x !== 0 || this.#intent.y !== 0) {
      const next = stepMovement(this.#map, this.#predicted, this.#intent, deltaSeconds);
      this.#predicted = { x: next.x, y: next.y };
      this.#facing = directionFromIntent(this.#intent, this.#facing);
      moving = true;
    } else if (this.#path.length > 0) {
      const { position, consumed, intent } = followPath(
        this.#map,
        this.#predicted,
        this.#path,
        deltaSeconds,
      );
      if (consumed > 0) this.#path = this.#path.slice(consumed);
      this.#predicted = position;
      this.#facing = directionFromIntent(intent, this.#facing);
      moving = this.#path.length > 0;
      if (!moving) this.#bridge.emit('path', { length: 0 });
    }

    self.setPosition(this.#predicted.x, this.#predicted.y);
    self.setFacing(this.#facing, moving);
  }

  /** At rest, close whatever gap is left between prediction and authority. */
  #settle(deltaSeconds: number): void {
    const self = this.#self;
    const authority = this.#authority;
    const localMoving = this.#intent.x !== 0 || this.#intent.y !== 0 || this.#path.length > 0;
    if (!self || !canSettle(authority, localMoving, this.#moveSeq)) return;
    if (authority.x === this.#predicted.x && authority.y === this.#predicted.y) return;

    this.#predicted = settle(this.#predicted, authority, deltaSeconds);
    self.setPosition(this.#predicted.x, this.#predicted.y);
  }

  // --- input ---------------------------------------------------------------

  #bindInput(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) throw new Error('Keyboard input is unavailable');

    this.#cursors = keyboard.createCursorKeys();
    this.#wasd = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    keyboard.on('keydown-Z', () => {
      if (!this.#inputCaptured) this.#toggleDebug();
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.#walkTo(pointer.worldX, pointer.worldY);
    });
  }

  /**
   * Hand the keyboard to the chat box, or take it back.
   *
   * Two things have to happen together, and forgetting either one is the
   * classic bug: Phaser stops reading the keys (so W doesn't walk you into a
   * wall while you type), *and* it stops calling preventDefault on them (so the
   * characters actually reach the input).
   */
  /**
   * Pixels per tile, for anything outside the scene that reasons in tiles.
   *
   * `null` until `create` has parsed the map. The scene exists — and is
   * handed out by `game.scene.getScene` — from the moment it is added, while
   * the map arrives with the assets some time later. The voice watcher
   * ticks ten times a second from the first moment, and its first ticks
   * landed in that gap: a TypeError on a field that was not there yet.
   */
  tileSize(): number | null {
    return this.#map ? this.#map.tileSize : null;
  }

  /** Light, or put out, the ring that says somebody is talking. */
  setSpeaking(sessionId: string, speaking: boolean): void {
    this.#avatars.get(sessionId)?.setSpeaking(speaking);
  }

  setInputCaptured(captured: boolean): void {
    this.#inputCaptured = captured;
    const keyboard = this.input.keyboard;
    if (!keyboard) return;

    keyboard.enabled = !captured;
    keyboard.disableGlobalCapture();
    if (!captured) keyboard.enableGlobalCapture();

    if (captured) {
      // Release any key the player was holding when they hit Enter, or the
      // server keeps walking them while they type.
      keyboard.resetKeys();
      this.#setIntent({ x: 0, y: 0 });
    }
  }

  #readKeyboard(): void {
    if (this.#inputCaptured) return;

    const left = this.#cursors.left.isDown || this.#wasd.left.isDown;
    const right = this.#cursors.right.isDown || this.#wasd.right.isDown;
    const up = this.#cursors.up.isDown || this.#wasd.up.isDown;
    const down = this.#cursors.down.isDown || this.#wasd.down.isDown;

    const intent = normalize({
      x: (right ? 1 : 0) - (left ? 1 : 0),
      y: (down ? 1 : 0) - (up ? 1 : 0),
    });

    this.#setIntent(intent);
  }

  /** Send intent only when it changes — one message per key press, not per frame. */
  #setIntent(intent: MoveIntent): void {
    this.#intent = intent;
    if (intent.x === this.#sentIntent.x && intent.y === this.#sentIntent.y) return;

    this.#sentIntent = intent;
    const payload: InputPayload = { ...intent, seq: ++this.#moveSeq };
    this.#room.send(ClientMessage.Input, payload);
    if (intent.x !== 0 || intent.y !== 0) this.#clearPath();
  }

  #walkTo(worldX: number, worldY: number): void {
    if (this.#inputCaptured) return;

    const target = {
      x: toTile(worldX, this.#map.tileSize),
      y: toTile(worldY, this.#map.tileSize),
    };
    // Clicking a desk should walk you next to it, not do nothing.
    const goal = nearestWalkable(this.#map, target);
    if (!goal) return;

    // Predict the same route the server is about to plan: same A*, same grid,
    // same start tile. Reconciliation covers the cases where they disagree.
    const path = findPath(this.#map, this.#predictedTile(), goal);
    this.#path = path;
    const payload: WalkToPayload = { ...goal, seq: ++this.#moveSeq };
    this.#room.send(ClientMessage.WalkTo, payload);
    this.#bridge.emit('path', { length: path.length });
  }

  #clearPath(): void {
    if (this.#path.length === 0) return;
    this.#path = [];
    this.#bridge.emit('path', { length: 0 });
  }

  /** Say something. Called by the React chat box, not by the scene. */
  say(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const requestId = this.#latencyRequest();
    this.#room.send(ClientMessage.Chat, { text: trimmed, requestId });
  }

  sayInChannel(channelId: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#room.send(ClientMessage.ChannelChat, {
      channelId,
      text: trimmed,
      requestId: this.#latencyRequest(),
    } satisfies ChannelChatSendPayload);
  }

  /** No retained log: a measurement observer may subscribe without seeing message content. */
  #latencyRequest(): string | undefined {
    if (typeof crypto.randomUUID !== 'function') return undefined;
    const requestId = crypto.randomUUID();
    window.dispatchEvent(new CustomEvent('quintal:human-send', {
      detail: { requestId, at: performance.now() },
    }));
    return requestId;
  }

  /** Ask for a page of a transcript; it arrives as a `history` event. */
  loadHistory(target: { channelId?: string; zoneId?: string; before?: number }): void {
    const payload: HistoryGetPayload = {};
    if (target.channelId) payload.channelId = target.channelId;
    if (target.zoneId) payload.zoneId = target.zoneId;
    if (target.before) payload.before = target.before;
    this.#room.send(ClientMessage.HistoryGet, payload);
  }

  /** Open a direct message with somebody. The office answers with `dm_opened`. */
  openDm(target: { memberId?: string; name?: string }): void {
    this.#room.send(ClientMessage.DmOpen, target satisfies DmOpenPayload);
  }

  /** Answer an agent's approval card. Refused by the office if it is not ours. */
  decideApproval(requestId: string, optionId: import('@quintal/shared').ApprovalOptionId): void {
    this.#room?.send(ClientMessage.ApprovalDecide, {
      requestId,
      optionId,
    } satisfies import('@quintal/shared').ApprovalDecidePayload);
  }

  followZone(zoneId: string | null): void {
    this.#room.send(ClientMessage.FollowZone, { zoneId } satisfies FollowZonePayload);
  }

  joinChannel(slug: string): void {
    this.#room.send(ClientMessage.ChannelJoin, { slug } satisfies ChannelJoinPayload);
  }

  leaveChannel(channelId: string): void {
    this.#room.send(ClientMessage.ChannelLeave, { channelId } satisfies ChannelLeavePayload);
  }

  /**
   * Tell the office this conversation is read, so the same person's other
   * screens agree. Nothing comes back: the next `channels` carries it.
   */
  markRead(channelId: string, at: number): void {
    this.#room.send(ClientMessage.Read, { channelId, at } satisfies ReadPayload);
  }

  // --- presentation --------------------------------------------------------

  /**
   * Draw the furniture.
   *
   * Props are sprites rather than tiles because they are not tile-shaped: a
   * desk is 61x44 inside a 128x96 cell and a garden tree is taller than three
   * tiles. Each is placed at the ground point it stands on and given that
   * point as its depth, which is the whole trick — people and furniture sort
   * against each other on one number, so you pass behind a bookcase and in
   * front of the desk below it without either being a special case.
   *
   * A `z` property overrides that for the things the rule gets wrong: a window
   * or a clock is on the wall behind everyone, whatever floor it hangs above.
   */
  #createProps(tilemap: Phaser.Tilemaps.Tilemap): void {
    const layer = tilemap.getObjectLayer('props');
    if (!layer) throw new Error('Map is missing the "props" layer');

    for (const object of layer.objects) {
      const properties = object.properties as
        | Array<{ name: string; value: string | number }>
        | undefined;
      const read = (name: string) => properties?.find((entry) => entry.name === name)?.value;

      const sprite = String(read('sprite') ?? '');
      const slash = sprite.indexOf('/');
      const atlas = sprite.slice(0, slash);
      const frame = sprite.slice(slash + 1);
      if (!isPropAtlasKey(atlas) || frame.length === 0) {
        throw new Error(`Prop "${sprite}" (object ${object.id}) names no known atlas`);
      }

      const x = object.x ?? 0;
      const y = object.y ?? 0;
      const z = read('z');
      this.add
        .image(x, y, `props-${atlas}`, frame)
        .setOrigin(0.5, PROP_ATLASES[atlas].origin)
        .setDepth(typeof z === 'number' ? z : y);
    }
  }

  /**
   * Idle and walk, for every body in every direction.
   *
   * Ninety-six animations sounds like a lot and costs nothing: they are frame
   * indices into sheets already in memory, and defining them all up front means
   * a body is never asked to play an animation that has not been created yet.
   *
   * The timings come from the pack and are uneven — idle holds for well over a
   * second and blinks for a tenth. Phaser divides an animation's `duration`
   * evenly across its frames and then adds each frame's own `duration`, so the
   * short frame sets the base and the long one carries the difference.
   */
  #createAnimations(): void {
    const states: BodyState[] = ['idle', 'walk'];
    for (const body of BODY_IDS) {
      for (const state of states) {
        const [longMs, shortMs] = BODY_TIMING[state];
        for (const direction of Object.keys(BODY_ROW) as Array<keyof typeof BODY_ROW>) {
          const [first, second] = bodyFrames(state, direction);
          this.anims.create({
            key: bodyAnimation(body, state, direction),
            frames: [
              { key: bodyTexture(body), frame: first, duration: longMs - shortMs },
              { key: bodyTexture(body), frame: second, duration: 0 },
            ],
            duration: shortMs * 2,
            repeat: -1,
          });
        }
      }
    }
  }

  #zoneLabels(): void {
    for (const zone of this.#map.zones) {
      const isAgentArea = zone.kind === 'agent_area';
      this.add
        .text(
          (zone.bounds.x + zone.bounds.width / 2) * this.#map.tileSize,
          (zone.bounds.y + (isAgentArea ? 0.6 : 0.4)) * this.#map.tileSize,
          isAgentArea ? zone.label.toUpperCase() : zone.label,
          {
            fontFamily: 'ui-monospace, monospace',
            fontSize: isAgentArea ? '14px' : '9px',
            color: isAgentArea ? '#04312b' : '#3d3d4d',
            fontStyle: isAgentArea ? 'bold' : 'normal',
          },
        )
        .setOrigin(0.5, 0.5)
        .setAlpha(isAgentArea ? 0.85 : 0.55)
        .setDepth(DEPTH.zoneLabel);
    }
  }

  // --- bookkeeping ---------------------------------------------------------

  #publishRoster(): void {
    const players: RosterEntry[] = [];
    for (const [sessionId, player] of this.#room.state.players) {
      players.push({
        sessionId,
        name: player.name,
        kind: player.kind,
        status: player.status,
        isSelf: sessionId === this.#selfId,
        ownerName: player.ownerName,
        ownerUserId: player.ownerUserId,
        scopes: player.scopes ? player.scopes.split(',') : [],
        runtimeId: player.runtimeId,
        modelId: player.modelId,
        identityId: player.userId,
        lastActionAt: this.#lastAction.get(sessionId) ?? 0,
        zoneId:
          zoneAt(this.#map, toTile(player.x, this.#map.tileSize), toTile(player.y, this.#map.tileSize))
            ?.id ?? FLOOR_ZONE_ID,
        emote: player.emote,
        workingIn: player.workingIn,
        workingSince: player.workingSince,
        isGuest: player.isGuest,
        description: player.description,
        pubkey: player.pubkey,
        avatar: player.avatar,
        task: player.kind === 'agent' ? agentTaskOf(player) : null,
      });
    }
    players.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));

    // Cheaper than it looks, and far cheaper than re-rendering a React list
    // twenty times a second because somebody took a step.
    const signature = players
      .map(
        (p) =>
          `${p.sessionId}:${p.name}:${p.kind}:${p.status}:${p.ownerName}:${p.isSelf ? 1 : 0}:${p.isGuest ? 1 : 0}:${p.zoneId}:${p.emote}:${p.workingIn}:${p.workingSince}:${p.task ? `${p.task.branch}#${p.task.pr?.number ?? ''}${p.task.pr?.state ?? ''}${p.task.title}` : ''}`,
      )
      .join('|');
    if (signature === this.#rosterSignature) return;
    this.#rosterSignature = signature;

    this.#bridge.emit('roster', { players, selfSessionId: this.#selfId || null });
  }

  #publishTile(): void {
    const tile = this.#predictedTile();
    if (tile.x === this.#currentTile.x && tile.y === this.#currentTile.y) return;
    this.#currentTile = tile;

    this.#bridge.emit('tile', { x: tile.x, y: tile.y, direction: this.#facing, kind: 'human' });

    const zone = zoneAt(this.#map, tile.x, tile.y);
    if (zone?.id !== this.#currentZone?.id) {
      this.#bridge.emit('zone', { zone, previous: this.#currentZone });
      this.#currentZone = zone;
    }
  }

  #predictedTile(): TilePoint {
    return {
      x: toTile(this.#predicted.x, this.#map.tileSize),
      y: toTile(this.#predicted.y, this.#map.tileSize),
    };
  }

  // --- debug overlay -------------------------------------------------------

  #toggleDebug(): void {
    this.#debugEnabled = !this.#debugEnabled;
    this.#debugStatic.setVisible(this.#debugEnabled);
    this.#debugPath.setVisible(this.#debugEnabled);

    if (this.#debugEnabled) {
      this.#drawDebugStatic();
      this.#drawDebugPath();
    } else {
      this.#debugStatic.clear();
      this.#debugPath.clear();
    }

    this.#bridge.emit('debug', { enabled: this.#debugEnabled });
  }

  /**
   * The map doesn't change, so this is drawn once per toggle rather than per
   * frame — 1200 fillRects every frame would cost more than the entire rest of
   * the scene put together.
   */
  #drawDebugStatic(): void {
    const { tileSize } = this.#map;
    const g = this.#debugStatic;
    g.clear();

    g.fillStyle(DEBUG_COLORS.collision, 0.28);
    for (let y = 0; y < this.#map.height; y += 1) {
      for (let x = 0; x < this.#map.width; x += 1) {
        if (this.#map.walkable[y * this.#map.width + x]) continue;
        g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }

    for (const zone of this.#map.zones) {
      const color = DEBUG_COLORS[zone.kind];
      g.lineStyle(2, color, 0.9);
      g.fillStyle(color, 0.12);
      const rect = new Phaser.Geom.Rectangle(
        zone.bounds.x * tileSize,
        zone.bounds.y * tileSize,
        zone.bounds.width * tileSize,
        zone.bounds.height * tileSize,
      );
      g.fillRectShape(rect);
      g.strokeRectShape(rect);
    }

    for (const spawn of this.#map.spawns) {
      g.fillStyle(spawn.kind === 'agent' ? DEBUG_COLORS.agent_area : DEBUG_COLORS.spawn, 0.9);
      g.fillCircle(
        tileCentre(spawn.x, tileSize),
        tileCentre(spawn.y, tileSize),
        4,
      );
    }
  }

  #drawDebugPath(): void {
    const g = this.#debugPath;
    g.clear();
    if (this.#path.length === 0) return;

    g.lineStyle(3, DEBUG_COLORS.path, 0.9);
    g.beginPath();
    g.moveTo(this.#predicted.x, this.#predicted.y);
    for (const step of this.#path) {
      g.lineTo(tileCentre(step.x, this.#map.tileSize), tileCentre(step.y, this.#map.tileSize));
    }
    g.strokePath();
  }
}
