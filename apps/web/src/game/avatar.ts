import {
  CHAT_BUBBLE_MS,
  INTERPOLATION_DELAY_MS,
  type Direction,
  type OfficePlayer,
  type PlayerKind,
} from '@quintal/shared';
import * as Phaser from 'phaser';

import { ASSETS, CHARACTER_FRAMES } from './constants';

/** One position the server told us about, with the time we heard it. */
interface Snapshot {
  at: number;
  x: number;
  y: number;
  dir: Direction;
  moving: boolean;
}

const LABEL_STYLE = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '10px',
  color: '#ffffff',
  backgroundColor: '#00000099',
  padding: { x: 3, y: 1 },
} as const;

const BUBBLE_STYLE = {
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: '11px',
  color: '#10131a',
  backgroundColor: '#f8fafc',
  padding: { x: 6, y: 4 },
  wordWrap: { width: 150 },
  align: 'center',
} as const;

/**
 * An occupant of the office: sprite, name label, and speech bubble.
 *
 * Remote avatars are rendered ~120ms behind the newest patch and interpolated
 * between snapshots. Rendering the newest position immediately would look
 * correct only if patches arrived perfectly evenly; they don't, and the result
 * is a visible stutter every time one is late. Trading a tenth of a second of
 * latency for smooth motion is the right deal for a room you walk around in.
 *
 * The local avatar skips all of that — it's driven by prediction and only
 * *corrected* by the server (see `OfficeScene`).
 */
export class Avatar {
  readonly sessionId: string;
  readonly kind: PlayerKind;

  readonly #scene: Phaser.Scene;
  readonly #sprite: Phaser.GameObjects.Sprite;
  readonly #label: Phaser.GameObjects.Text;
  #bubble: Phaser.GameObjects.Text | null = null;
  #bubbleUntil = 0;

  readonly #snapshots: Snapshot[] = [];
  #facing: Direction = 'down';
  #moving = false;
  #name: string;
  #status = '';

  constructor(
    scene: Phaser.Scene,
    sessionId: string,
    player: OfficePlayer,
    readonly isSelf: boolean,
  ) {
    this.#scene = scene;
    this.sessionId = sessionId;
    this.kind = player.kind;
    this.#name = player.name;
    this.#status = player.status;

    this.#sprite = scene.add
      .sprite(player.x, player.y, `${ASSETS.tileset}-frames`, CHARACTER_FRAMES.down[0])
      // Feet-anchored: the sprite's centre of mass is its middle, but the
      // position the server tracks is where it stands.
      .setOrigin(0.5, 0.75)
      .setDepth(isSelf ? 12 : 10);

    this.#label = scene.add
      .text(player.x, player.y, this.#labelText(), LABEL_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(20);

    if (isSelf) this.#label.setColor('#8affc1');
    else if (player.kind === 'agent') this.#label.setColor('#4dd4ff');

    this.#snapshots.push({
      at: performance.now(),
      x: player.x,
      y: player.y,
      dir: player.dir,
      moving: player.moving,
    });
  }

  get sprite(): Phaser.GameObjects.Sprite {
    return this.#sprite;
  }

  get name(): string {
    return this.#name;
  }

  /** Record a server patch. Remote avatars replay these on a delay. */
  pushSnapshot(player: OfficePlayer, at: number = performance.now()): void {
    this.#snapshots.push({
      at,
      x: player.x,
      y: player.y,
      dir: player.dir,
      moving: player.moving,
    });

    // Two snapshots older than the interpolation window is all we ever need:
    // one to interpolate from, one to interpolate to.
    while (this.#snapshots.length > 2 && (this.#snapshots[1]?.at ?? 0) < at - INTERPOLATION_DELAY_MS * 2) {
      this.#snapshots.shift();
    }

    if (this.#name !== player.name || this.#status !== player.status) {
      this.#name = player.name;
      this.#status = player.status;
      this.#label.setText(this.#labelText());
    }
  }

  /** Move a remote avatar to where it was `INTERPOLATION_DELAY_MS` ago. */
  interpolate(now: number = performance.now()): void {
    const renderAt = now - INTERPOLATION_DELAY_MS;

    let from = this.#snapshots[0];
    let to = this.#snapshots[this.#snapshots.length - 1];
    if (!from || !to) return;

    for (let i = 0; i < this.#snapshots.length - 1; i += 1) {
      const candidate = this.#snapshots[i];
      const next = this.#snapshots[i + 1];
      if (!candidate || !next) continue;
      if (candidate.at <= renderAt && next.at >= renderAt) {
        from = candidate;
        to = next;
        break;
      }
    }

    const span = to.at - from.at;
    const progress = span <= 0 ? 1 : Math.min(1, Math.max(0, (renderAt - from.at) / span));

    this.setPosition(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress);
    this.setFacing(to.dir, to.moving);
  }

  setPosition(x: number, y: number): void {
    this.#sprite.setPosition(x, y);
    this.#label.setPosition(x, y - 22);
    if (this.#bubble) this.#bubble.setPosition(x, y - 36);
  }

  setFacing(dir: Direction, moving: boolean): void {
    if (dir === this.#facing && moving === this.#moving) return;
    this.#facing = dir;
    this.#moving = moving;

    if (moving) {
      this.#sprite.anims.play(`walk-${dir}`, true);
    } else {
      this.#sprite.anims.stop();
      this.#sprite.setFrame(CHARACTER_FRAMES[dir][0]);
    }
  }

  /** Show what this occupant just said, for a few seconds. */
  say(text: string, now: number = performance.now()): void {
    this.#bubble?.destroy();
    this.#bubble = this.#scene.add
      .text(this.#sprite.x, this.#sprite.y - 36, text, BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(30);
    this.#bubbleUntil = now + CHAT_BUBBLE_MS;
  }

  /** Drop an expired speech bubble. Call once per frame. */
  tickBubble(now: number = performance.now()): void {
    if (!this.#bubble || now < this.#bubbleUntil) return;
    this.#bubble.destroy();
    this.#bubble = null;
  }

  destroy(): void {
    this.#sprite.destroy();
    this.#label.destroy();
    this.#bubble?.destroy();
  }

  #labelText(): string {
    const marker = this.kind === 'agent' ? '◆ ' : '';
    return this.#status ? `${marker}${this.#name} · ${this.#status}` : `${marker}${this.#name}`;
  }
}
