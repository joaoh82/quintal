import { MapSchema, Schema, defineTypes } from '@colyseus/schema';

import type { Direction, PlayerKind } from '../player.js';

/**
 * Colyseus room state, shared verbatim by the server (which owns it) and the
 * browser (which decodes it).
 *
 * Two deliberate choices, both load-bearing:
 *
 * - `defineTypes` rather than decorators, so consumers of this package aren't
 *   forced on to `experimentalDecorators`.
 * - No custom constructors. `defineTypes` needs the constructor signature it
 *   inherits from `Schema`, and a narrower one doesn't typecheck. Use
 *   `createPlayer` below to build a populated player.
 *
 * The field initialisers here rely on `useDefineForClassFields: false` (set in
 * this package's tsconfig): they must compile to assignments so they pass
 * through the change-tracking accessors schema installs on the prototype. As
 * own properties they would shadow those accessors and state would silently
 * stop syncing. `state.test.ts` guards this.
 */
export class OfficePlayer extends Schema {
  userId = '';
  name = 'Someone';
  /** World position in pixels — the avatar's centre of mass, not its head. */
  x = 0;
  y = 0;
  dir: Direction = 'down';
  moving = false;
  /** Which character block on the sprite sheet to draw. */
  spriteKey = 'default';
  /**
   * Humans today, agents from the next step. Every consumer must branch on this
   * rather than assuming a human — rosters, labels and movement all read it.
   */
  kind: PlayerKind = 'human';
  /** Free-text presence line: "idle", "running tests", … */
  status = '';
  /**
   * For agents: the human who owns this one, shown wherever it appears. Empty
   * for humans. Attribution is not optional — an agent acting with nobody
   * accountable for it is the thing this field exists to prevent.
   */
  ownerName = '';
  /**
   * For agents: `users.id` of the owner. Synced alongside the name because a
   * name is not an identity — the roster has to answer "is this one *mine*"
   * (may I message it directly, may I put it in a channel) and a self-chosen
   * display name cannot answer that.
   */
  ownerUserId = '';
  /** For agents: comma-joined scopes, so the profile card can show them. */
  scopes = '';
  /**
   * The balloon over the head — an emote id from the catalogue, or empty.
   * Server-owned: an agent asks, the office validates, everybody draws it.
   */
  emote = '';
  /** When the balloon comes down, ms since epoch. 0 means "when cleared". */
  emoteUntil = 0;
  /**
   * For agents: the channel or DM the current turn is for, or empty when the
   * work is spatial (a zone) or there is none. A status line says *what* an
   * agent is doing; this says *where*, so the conversation it is answering
   * can show it working there rather than only the map.
   */
  workingIn = '';
  /**
   * For humans: arrived through a guest link rather than with their own
   * identity. Shown as a badge, because "who is this person and should they be
   * hearing this" is a question the room has to answer visually — the same
   * reason agents are marked rather than blending in.
   */
  isGuest = false;
  /** Profile line, shown on the card you get by clicking somebody. */
  description = '';
  /**
   * For humans: the x-only public key, hex. Empty for agents.
   *
   * Synced because a display name is self-asserted and duplicates are allowed,
   * so the profile card has to be able to show the thing that actually
   * distinguishes two people who chose to be called the same. Without this the
   * card can only show a name and an internal id, which distinguishes nothing
   * a person could check.
   */
  pubkey = '';
}

defineTypes(OfficePlayer, {
  userId: 'string',
  name: 'string',
  x: 'number',
  y: 'number',
  dir: 'string',
  moving: 'boolean',
  spriteKey: 'string',
  kind: 'string',
  status: 'string',
  ownerName: 'string',
  ownerUserId: 'string',
  scopes: 'string',
  emote: 'string',
  emoteUntil: 'number',
  workingIn: 'string',
  isGuest: 'boolean',
  description: 'string',
  pubkey: 'string',
});

export class OfficeState extends Schema {
  mapId = 'hq';
  players = new MapSchema<OfficePlayer>();
}

defineTypes(OfficeState, {
  mapId: 'string',
  players: { map: OfficePlayer },
});

export interface PlayerInit {
  userId: string;
  name: string;
  x: number;
  y: number;
  dir?: Direction;
  spriteKey?: string;
  kind?: PlayerKind;
  status?: string;
  ownerName?: string;
  ownerUserId?: string;
  scopes?: readonly string[];
  isGuest?: boolean;
  description?: string;
  pubkey?: string;
}

/** Build a populated player. Assignment, not construction — see the note above. */
export function createPlayer(init: PlayerInit): OfficePlayer {
  const player = new OfficePlayer();
  player.userId = init.userId;
  player.name = init.name;
  player.x = init.x;
  player.y = init.y;
  player.dir = init.dir ?? 'down';
  player.moving = false;
  player.spriteKey = init.spriteKey ?? 'default';
  player.kind = init.kind ?? 'human';
  player.status = init.status ?? '';
  player.ownerName = init.ownerName ?? '';
  player.ownerUserId = init.ownerUserId ?? '';
  player.scopes = (init.scopes ?? []).join(',');
  player.isGuest = init.isGuest ?? false;
  player.description = init.description ?? '';
  player.pubkey = init.pubkey ?? '';
  return player;
}
