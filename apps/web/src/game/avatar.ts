import {
  CHAT_BUBBLE_MS,
  INTERPOLATION_DELAY_MS,
  bodyForSeed,
  emoteFrames,
  isBodyId,
  isEmote,
  type BodyId,
  type Direction,
  type OfficePlayer,
  type PlayerKind,
} from '@quintal/shared';
import * as Phaser from 'phaser';

import {
  ASSETS,
  BODY_ORIGIN,
  DEPTH,
  EMOTE_FRAME_MS,
  bodyAnimation,
  bodyFrames,
  bodyTexture,
} from './constants';

/**
 * Which of the twelve bodies somebody walks around in.
 *
 * `spriteKey` wins when it names one, which is the hook a chooser will hang
 * off; today only agents carry one and its three legacy values are colours,
 * not bodies, so in practice everybody falls through to the derived answer.
 * The seed is the stable identity where there is one — a reconnect must not
 * change somebody's face — and the name only for a guest who has no identity
 * to speak of.
 */
function bodyFor(sessionId: string, player: OfficePlayer): BodyId {
  if (isBodyId(player.spriteKey)) return player.spriteKey;
  return bodyForSeed(player.userId || player.name || sessionId);
}

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
 * of the nameplate. One constant for the two places that position it — the
 * first version offset it to the right and it read as belonging to whoever
 * stood there.
 */
const EMOTE_OFFSET = { x: 0, y: -52 } as const;

/**
 * Where the overlays sit above the feet.
 *
 * A body is 48px of frame standing on its 42nd row, so the head clears y-34 —
 * twelve pixels higher than the sprite this replaced. Everything above the
 * head moved up by exactly that, which is why these are one block of numbers
 * rather than magic constants at each call site.
 */
const LABEL_Y = -34;
const STATUS_Y = -24;
const BUBBLE_Y = -48;

/** The speaking ring: the roster's green, so the two read as one signal. */
const SPEAKING_RING_COLOR = 0x34d399;

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
  readonly body: BodyId;
  /** Scratch space for the scene's "did anything notable change" test. */
  lastStatus = '';

  readonly #scene: Phaser.Scene;
  readonly #sprite: Phaser.GameObjects.Sprite;
  readonly #label: Phaser.GameObjects.Text;
  /** Agents only: the ring on the floor and the status line under the plate. */
  readonly #ring: Phaser.GameObjects.Ellipse | null = null;
  /** Anybody, while talking: a brighter ring under the feet. Made on first use. */
  #voiceRing: Phaser.GameObjects.Ellipse | null = null;
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
    this.body = bodyFor(sessionId, player);

    this.#sprite = scene.add
      .sprite(player.x, player.y, bodyTexture(this.body), bodyFrames('idle', 'down')[0])
      // Feet-anchored: the sprite's centre of mass is its middle, but the
      // position the server tracks is where it stands — and where it stands is
      // also what it sorts by against the furniture.
      .setOrigin(BODY_ORIGIN.x, BODY_ORIGIN.y)
      .setDepth(player.y);
    // Started here and not left to `setFacing`, which short-circuits when
    // nothing changed — and standing still facing south is exactly the state
    // an avatar is born in.
    this.#sprite.anims.play(bodyAnimation(this.body, 'idle', 'down'));

    const isAgent = player.kind === 'agent';

    if (isAgent) {
      // Under the feet, deliberately low-contrast: it should read as "not a
      // person" in peripheral vision without competing with the room.
      this.#ring = scene.add
        .ellipse(player.x, player.y + 6, 22, 10, AGENT_RING_COLOR, 0.28)
        .setStrokeStyle(1, AGENT_RING_COLOR, 0.55)
        .setDepth(player.y + DEPTH.ringOffset);
    }

    this.#label = scene.add
      .text(player.x, player.y, this.#labelText(), isAgent ? AGENT_LABEL_STYLE : LABEL_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.label);

    if (isSelf) this.#label.setColor('#8affc1');

    if (isAgent) {
      this.#statusLine = scene.add
        .text(player.x, player.y + STATUS_Y, player.status, AGENT_STATUS_STYLE)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.status)
        .setVisible(player.status.length > 0);
      // The balloon: centred over the head, above the nameplate. A speech
      // bubble sits a little higher still, so a laugh and the line that
      // caused it can both be read.
      this.#emoteSprite = scene.add
        .sprite(player.x + EMOTE_OFFSET.x, player.y + EMOTE_OFFSET.y, ASSETS.emotes, 0)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.emote)
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

  /**
   * Somebody is talking. The ring is the office's one visual for voice, so
   * a person reading the room can see who is speaking without hearing it —
   * the roster shows the same thing in a list.
   */
  setSpeaking(speaking: boolean): void {
    if (!speaking) {
      this.#voiceRing?.setVisible(false);
      return;
    }
    if (!this.#voiceRing) {
      this.#voiceRing = this.#scene.add
        .ellipse(this.#sprite.x, this.#sprite.y + 6, 26, 12, SPEAKING_RING_COLOR, 0.14)
        .setStrokeStyle(2, SPEAKING_RING_COLOR, 0.9)
        .setDepth(this.#sprite.y + DEPTH.ringOffset);
    }
    this.#voiceRing.setVisible(true);
  }

  setPosition(x: number, y: number): void {
    // Depth is the y of the feet, on the same scale props sort by, so the
    // office draws itself in the order you would see it from here.
    this.#sprite.setPosition(x, y).setDepth(y);
    this.#label.setPosition(x, y + LABEL_Y);
    this.#ring?.setPosition(x, y + 6).setDepth(y + DEPTH.ringOffset);
    this.#voiceRing?.setPosition(x, y + 6).setDepth(y + DEPTH.ringOffset);
    this.#statusLine?.setPosition(x, y + STATUS_Y);
    if (this.#bubble) this.#bubble.setPosition(x, y + BUBBLE_Y);
    this.#emoteSprite?.setPosition(x + EMOTE_OFFSET.x, y + EMOTE_OFFSET.y);
  }

  /**
   * Face a direction, walking or standing.
   *
   * Standing still plays an idle loop rather than freezing on a frame: the old
   * sheet had nothing else to offer, and a room of people holding one pose
   * reads as a screenshot. Both states are animations, so this is one call
   * either way.
   */
  setFacing(dir: Direction, moving: boolean): void {
    if (dir === this.#facing && moving === this.#moving) return;
    this.#facing = dir;
    this.#moving = moving;
    this.#sprite.anims.play(bodyAnimation(this.body, moving ? 'walk' : 'idle', dir), true);
  }

  /** Show what this occupant just said, for a few seconds. */
  say(text: string, now: number = performance.now()): void {
    this.#bubble?.destroy();
    this.#bubble = this.#scene.add
      .text(this.#sprite.x, this.#sprite.y + BUBBLE_Y, text, BUBBLE_STYLE)
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.bubble);
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
    this.#voiceRing?.destroy();
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
