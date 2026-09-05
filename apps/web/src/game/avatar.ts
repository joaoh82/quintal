import {
  CHAT_BUBBLE_MS,
  INTERPOLATION_DELAY_MS,
  emoteFrames,
  isEmote,
  type Direction,
  type OfficePlayer,
  type PlayerKind,
} from '@quintal/shared';
import * as Phaser from 'phaser';

import { ASSETS, CHARACTER_FRAMES, EMOTE_FRAME_MS } from './constants';

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

/**
 * Agents get a different nameplate, not a different body.
 *
 * The stance is that an agent must be unmistakable at a glance without being
 * turned into a mascot: same sprite sheet as everyone else, but a cool-toned
 * plate, a bot glyph, the owner's name, and a desaturated ring on the floor.
 * A costume would make them cute; a badge makes them legible.
 */
const AGENT_LABEL_STYLE = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '10px',
  color: '#dbeafe',
  backgroundColor: '#0b2942dd',
  padding: { x: 4, y: 1 },
} as const;

/**
 * Where the balloon sits relative to the feet: centred over the head, clear
 * of the nameplate (which spans roughly y−36 to y−22). One constant for the
 * two places that position it — the first version offset it to the right
 * and it read as belonging to whoever stood there.
 */
const EMOTE_OFFSET = { x: 0, y: -40 } as const;

/** Glyph on every agent nameplate. Non-human, and obviously so. */
const AGENT_GLYPH = '◆';

const AGENT_RING_COLOR = 0x7d9bb5;
const AGENT_STATUS_STYLE = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '8px',
  color: '#a8c6e0',
  backgroundColor: '#0b294299',
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
  /** Scratch space for the scene's "did anything notable change" test. */
  lastStatus = '';

  readonly #scene: Phaser.Scene;
  readonly #sprite: Phaser.GameObjects.Sprite;
  readonly #label: Phaser.GameObjects.Text;
  /** Agents only: the ring on the floor and the status line under the plate. */
  readonly #ring: Phaser.GameObjects.Ellipse | null = null;
  readonly #statusLine: Phaser.GameObjects.Text | null = null;
  #bubble: Phaser.GameObjects.Text | null = null;
  #bubbleUntil = 0;
  /** Agents only: the balloon over the head, and what it is showing. */
  #emoteSprite: Phaser.GameObjects.Sprite | null = null;
  #emote = '';
  #emoteUntil = 0;
  #emoteFrames: number[] = [];
  #emoteIndex = 0;
  #emoteFrameAt = 0;

  readonly #snapshots: Snapshot[] = [];
  #facing: Direction = 'down';
  #moving = false;
  #name: string;
  #status = '';
  readonly #owner: string;

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
    this.#owner = player.ownerName;

    this.#sprite = scene.add
      .sprite(player.x, player.y, `${ASSETS.tileset}-frames`, CHARACTER_FRAMES.down[0])
      // Feet-anchored: the sprite's centre of mass is its middle, but the
      // position the server tracks is where it stands.
      .setOrigin(0.5, 0.75)
      .setDepth(isSelf ? 12 : 10);

    const isAgent = player.kind === 'agent';

    if (isAgent) {
      // Under the feet, deliberately low-contrast: it should read as "not a
      // person" in peripheral vision without competing with the room.
      this.#ring = scene.add
        .ellipse(player.x, player.y + 6, 22, 10, AGENT_RING_COLOR, 0.28)
        .setStrokeStyle(1, AGENT_RING_COLOR, 0.55)
        .setDepth(9);
    }

    this.#label = scene.add
      .text(player.x, player.y, this.#labelText(), isAgent ? AGENT_LABEL_STYLE : LABEL_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(20);

    if (isSelf) this.#label.setColor('#8affc1');

    if (isAgent) {
      this.#statusLine = scene.add
        .text(player.x, player.y - 12, player.status, AGENT_STATUS_STYLE)
        .setOrigin(0.5, 1)
        .setDepth(19)
        .setVisible(player.status.length > 0);
      // The balloon: centred over the head, above the nameplate. A speech
      // bubble sits a little higher still, so a laugh and the line that
      // caused it can both be read.
      this.#emoteSprite = scene.add
        .sprite(player.x + EMOTE_OFFSET.x, player.y + EMOTE_OFFSET.y, ASSETS.emotes, 0)
        .setOrigin(0.5, 1)
        .setDepth(31)
        .setVisible(false);
      this.setEmote(player.emote, player.emoteUntil);
    }

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
      this.#statusLine?.setText(this.#status).setVisible(this.#status.length > 0);
    }
    if (this.#emote !== player.emote || this.#emoteUntil !== player.emoteUntil) {
      this.setEmote(player.emote, player.emoteUntil);
    }
  }

  /**
   * Show a balloon, or none. `until` is ms since epoch, 0 for "until
   * replaced". The office brings a timed balloon down on its own; the client
   * also hides it on time so a late patch does not leave it up a second long.
   */
  setEmote(emote: string, until: number): void {
    this.#emote = emote;
    this.#emoteUntil = until;
    if (!this.#emoteSprite) return;
    this.#emoteFrames = isEmote(emote) ? emoteFrames(emote) : [];
    this.#emoteIndex = 0;
    const first = this.#emoteFrames[0];
    if (first === undefined) {
      this.#emoteSprite.setVisible(false);
      return;
    }
    this.#emoteSprite.setFrame(first).setVisible(true);
  }

  /** Advance a multi-frame balloon, and drop a timed one when its time is up. */
  tickEmote(now: number = performance.now()): void {
    const sprite = this.#emoteSprite;
    if (!sprite || !sprite.visible) return;
    if (this.#emoteUntil !== 0 && Date.now() >= this.#emoteUntil) {
      sprite.setVisible(false);
      return;
    }
    if (this.#emoteFrames.length < 2) return;
    if (now - this.#emoteFrameAt < EMOTE_FRAME_MS) return;
    this.#emoteFrameAt = now;
    this.#emoteIndex = (this.#emoteIndex + 1) % this.#emoteFrames.length;
    const frame = this.#emoteFrames[this.#emoteIndex];
    if (frame !== undefined) sprite.setFrame(frame);
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
    this.#ring?.setPosition(x, y + 6);
    this.#statusLine?.setPosition(x, y - 12);
    if (this.#bubble) this.#bubble.setPosition(x, y - 36);
    this.#emoteSprite?.setPosition(x + EMOTE_OFFSET.x, y + EMOTE_OFFSET.y);
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
    this.#ring?.destroy();
    this.#statusLine?.destroy();
    this.#bubble?.destroy();
    this.#emoteSprite?.destroy();
  }

  /**
   * Humans get their name. Agents get the glyph, their name, and whose they are
   * — attribution travels with the avatar, not just the roster, because the
   * avatar is what you actually look at.
   */
  #labelText(): string {
    if (this.kind !== 'agent') return this.#name;
    return this.#owner ? `${AGENT_GLYPH} ${this.#name} · ${this.#owner}'s` : `${AGENT_GLYPH} ${this.#name}`;
  }
}
