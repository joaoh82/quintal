import {
  findPath,
  nearestWalkable,
  parseTiledMap,
  spawnFor,
  zoneAt,
  type Direction,
  type GameBridge,
  type MapZone,
  type OfficeMap,
  type TilePoint,
  type TiledMap,
} from '@quintal/shared';
// Namespace import, not default: Phaser's ESM build (`module` entry, which is
// what the bundler picks) has no default export, and webpack warns on every
// build if you ask for one.
import * as Phaser from 'phaser';

import {
  ASSETS,
  BODY,
  CAMERA_LERP,
  CAMERA_ZOOM,
  CHARACTER_FRAMES,
  DEBUG_COLORS,
  PATHS,
  WALK_SPEED,
} from '../constants';

interface OfficeSceneData {
  bridge: GameBridge;
}

/**
 * The office. One local player, no networking — the server takes over
 * authority later, at which point `applyInput` becomes "send to server" and
 * the sprite becomes a puppet of room state.
 */
export class OfficeScene extends Phaser.Scene {
  static readonly KEY = 'office';

  #bridge!: GameBridge;
  #map!: OfficeMap;
  #player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  #cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  #wasd!: Record<'up' | 'down' | 'left' | 'right', Phaser.Input.Keyboard.Key>;

  /** Remaining click-to-move waypoints, in tiles. Empty when walking manually. */
  #path: TilePoint[] = [];
  #facing: Direction = 'down';
  #currentZone: MapZone | null = null;
  #currentTile: TilePoint = { x: -1, y: -1 };

  /**
   * Offset from the sprite's centre to the physics body's centre. The body sits
   * at the avatar's feet, so "which tile am I on" must be asked of the body —
   * ask the sprite and standing under a wall reports you inside it, which makes
   * the pathfinder refuse to plan a route from a "blocked" start.
   */
  #feet = { x: 0, y: 0 };

  #debugEnabled = false;
  /** Collision tiles and zones: static, redrawn only when toggled on. */
  #debugStatic!: Phaser.GameObjects.Graphics;
  /** The current route: cheap, redrawn every frame. */
  #debugPath!: Phaser.GameObjects.Graphics;
  #labelLayer!: Phaser.GameObjects.Container;

  constructor() {
    super(OfficeScene.KEY);
  }

  init(data: OfficeSceneData): void {
    this.#bridge = data.bridge;
  }

  preload(): void {
    this.load.image(ASSETS.tileset, PATHS.tileset);
    this.load.tilemapTiledJSON(ASSETS.map, PATHS.map);
    // The character shares the tileset image; load it again as a spritesheet so
    // frame indices line up with the sheet's tile indices.
    this.load.spritesheet(`${ASSETS.tileset}-frames`, PATHS.tileset, {
      frameWidth: 32,
      frameHeight: 32,
    });
  }

  create(): void {
    const tilemap = this.make.tilemap({ key: ASSETS.map });
    const tileset = tilemap.addTilesetImage(ASSETS.tileset, ASSETS.tileset);
    if (!tileset) throw new Error('Tileset image failed to attach to the tilemap');

    // Same JSON, parsed through the shared parser: the walkability grid the
    // pathfinder uses is the one the server will use, not a second opinion.
    this.#map = parseTiledMap(this.cache.tilemap.get(ASSETS.map).data as TiledMap);

    const floor = tilemap.createLayer('floor', tileset, 0, 0);
    const walls = tilemap.createLayer('walls', tileset, 0, 0);
    const furniture = tilemap.createLayer('furniture', tileset, 0, 0);
    const decor = tilemap.createLayer('decor', tileset, 0, 0);
    if (!floor || !walls || !furniture || !decor) {
      throw new Error('Map is missing one of: floor, walls, furniture, decor');
    }

    // Anything present on a collision layer blocks. Doors are simply holes.
    walls.setCollisionByExclusion([-1]);
    furniture.setCollisionByExclusion([-1]);

    this.#createAnimations();

    const spawn = spawnFor(this.#map, 'human');
    this.#player = this.physics.add.sprite(
      this.#toWorld(spawn.x),
      this.#toWorld(spawn.y),
      `${ASSETS.tileset}-frames`,
      CHARACTER_FRAMES.down[0],
    );
    this.#player.setDepth(10);
    this.#player.body.setSize(BODY.width, BODY.height);
    this.#player.body.setOffset(BODY.offsetX, BODY.offsetY);
    this.#player.setCollideWorldBounds(true);

    this.#player.body.updateFromGameObject();
    this.#feet = {
      x: this.#player.body.center.x - this.#player.x,
      y: this.#player.body.center.y - this.#player.y,
    };
    // Re-place so the *body* lands on the spawn tile, not the sprite's middle.
    this.#player.setPosition(this.#toSpriteX(spawn.x), this.#toSpriteY(spawn.y));

    this.physics.add.collider(this.#player, walls);
    this.physics.add.collider(this.#player, furniture);
    // A blocked move means the route is stale — fall back to manual walking.
    this.#player.body.onCollide = true;
    this.physics.world.on('collide', () => this.#clearPath());

    this.#zoneLabels();
    this.#debugStatic = this.add.graphics().setDepth(50).setVisible(false);
    this.#debugPath = this.add.graphics().setDepth(51).setVisible(false);

    const world = { width: tilemap.widthInPixels, height: tilemap.heightInPixels };
    this.physics.world.setBounds(0, 0, world.width, world.height);
    this.cameras.main.setBounds(0, 0, world.width, world.height);
    this.cameras.main.setZoom(CAMERA_ZOOM);
    this.cameras.main.startFollow(this.#player, true, CAMERA_LERP, CAMERA_LERP);
    this.cameras.main.roundPixels = true;

    this.#bindInput();

    this.#bridge.emit('ready', {
      mapName: this.#map.name,
      width: this.#map.width,
      height: this.#map.height,
    });
    this.#publishTile(true);
  }

  override update(): void {
    const body = this.#player.body;
    const keyboard = this.#readKeyboard();

    if (keyboard.x !== 0 || keyboard.y !== 0) {
      this.#clearPath();
      body.setVelocity(keyboard.x * WALK_SPEED, keyboard.y * WALK_SPEED);
    } else if (this.#path.length > 0) {
      this.#followPath();
    } else {
      body.setVelocity(0, 0);
    }

    this.#animate(body.velocity);
    this.#publishTile(false);
    if (this.#debugEnabled) this.#drawDebugPath();
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

    keyboard.on('keydown-Z', () => this.#toggleDebug());

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.#walkTo(pointer.worldX, pointer.worldY);
    });
  }

  /** Normalised movement intent. Diagonals are scaled so they aren't faster. */
  #readKeyboard(): { x: number; y: number } {
    const left = this.#cursors.left.isDown || this.#wasd.left.isDown;
    const right = this.#cursors.right.isDown || this.#wasd.right.isDown;
    const up = this.#cursors.up.isDown || this.#wasd.up.isDown;
    const down = this.#cursors.down.isDown || this.#wasd.down.isDown;

    const x = (right ? 1 : 0) - (left ? 1 : 0);
    const y = (down ? 1 : 0) - (up ? 1 : 0);
    if (x !== 0 && y !== 0) return { x: x * Math.SQRT1_2, y: y * Math.SQRT1_2 };
    return { x, y };
  }

  // --- click to move -------------------------------------------------------

  #walkTo(worldX: number, worldY: number): void {
    const target = { x: this.#toTile(worldX), y: this.#toTile(worldY) };
    // Clicking a desk should walk you next to it, not do nothing.
    const goal = nearestWalkable(this.#map, target);
    if (!goal) return;

    const path = findPath(this.#map, this.#playerTile(), goal);
    this.#path = path;
    this.#bridge.emit('path', { length: path.length });
  }

  #followPath(): void {
    const next = this.#path[0];
    if (!next) return this.#clearPath();

    const targetX = this.#toSpriteX(next.x);
    const targetY = this.#toSpriteY(next.y);
    const dx = targetX - this.#player.x;
    const dy = targetY - this.#player.y;

    // Close enough: bank the waypoint and aim at the next one. The tolerance is
    // a hair over one frame of travel, so we don't orbit the target forever.
    const arriveRadius = WALK_SPEED * (this.game.loop.delta / 1000) + 1;
    if (Math.hypot(dx, dy) <= arriveRadius) {
      this.#player.setPosition(targetX, targetY);
      this.#path.shift();
      if (this.#path.length === 0) {
        this.#player.body.setVelocity(0, 0);
        this.#bridge.emit('path', { length: 0 });
      }
      return;
    }

    const angle = Math.atan2(dy, dx);
    this.#player.body.setVelocity(Math.cos(angle) * WALK_SPEED, Math.sin(angle) * WALK_SPEED);
  }

  #clearPath(): void {
    if (this.#path.length === 0) return;
    this.#path = [];
    this.#bridge.emit('path', { length: 0 });
  }

  // --- presentation --------------------------------------------------------

  #createAnimations(): void {
    const key = `${ASSETS.tileset}-frames`;
    for (const [direction, frames] of Object.entries(CHARACTER_FRAMES)) {
      this.anims.create({
        key: `walk-${direction}`,
        frames: frames.map((frame) => ({ key, frame })),
        frameRate: 8,
        repeat: -1,
      });
    }
  }

  #animate(velocity: Phaser.Math.Vector2): void {
    const moving = velocity.lengthSq() > 1;

    if (moving) {
      this.#facing =
        Math.abs(velocity.x) > Math.abs(velocity.y)
          ? velocity.x > 0
            ? 'right'
            : 'left'
          : velocity.y > 0
            ? 'down'
            : 'up';
      this.#player.anims.play(`walk-${this.#facing}`, true);
      return;
    }

    this.#player.anims.stop();
    this.#player.setFrame(CHARACTER_FRAMES[this.#facing][0]);
  }

  /** Zone names, drawn once, so the office reads without the debug overlay. */
  #zoneLabels(): void {
    this.#labelLayer = this.add.container(0, 0).setDepth(5);

    for (const zone of this.#map.zones) {
      const isAgentArea = zone.kind === 'agent_area';
      const label = this.add
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
        .setAlpha(isAgentArea ? 0.85 : 0.55);
      this.#labelLayer.add(label);
    }
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

    // Blocked tiles, straight from the shared walkability grid — if this
    // disagrees with what you bump into, the grid and the layers have drifted.
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
      g.fillCircle(this.#toWorld(spawn.x), this.#toWorld(spawn.y), 4);
    }
  }

  #drawDebugPath(): void {
    const g = this.#debugPath;
    g.clear();
    if (this.#path.length === 0) return;

    g.lineStyle(3, DEBUG_COLORS.path, 0.9);
    g.beginPath();
    g.moveTo(this.#player.body.center.x, this.#player.body.center.y);
    for (const step of this.#path) g.lineTo(this.#toWorld(step.x), this.#toWorld(step.y));
    g.strokePath();
  }

  // --- bookkeeping ---------------------------------------------------------

  #publishTile(force: boolean): void {
    const tile = this.#playerTile();
    if (!force && tile.x === this.#currentTile.x && tile.y === this.#currentTile.y) return;
    this.#currentTile = tile;

    this.#bridge.emit('tile', { x: tile.x, y: tile.y, direction: this.#facing, kind: 'human' });

    const zone = zoneAt(this.#map, tile.x, tile.y);
    if (zone?.id !== this.#currentZone?.id) {
      this.#bridge.emit('zone', { zone, previous: this.#currentZone });
      this.#currentZone = zone;
    }
  }

  /** Which tile the avatar is standing on — asked of the feet, not the head. */
  #playerTile(): TilePoint {
    const body = this.#player.body;
    return { x: this.#toTile(body.center.x), y: this.#toTile(body.center.y) };
  }

  /** Sprite position that puts the body's centre on a tile's centre. */
  #toSpriteX(tile: number): number {
    return this.#toWorld(tile) - this.#feet.x;
  }

  #toSpriteY(tile: number): number {
    return this.#toWorld(tile) - this.#feet.y;
  }

  #toTile(world: number): number {
    return Math.floor(world / this.#map.tileSize);
  }

  #toWorld(tile: number): number {
    return tile * this.#map.tileSize + this.#map.tileSize / 2;
  }
}
