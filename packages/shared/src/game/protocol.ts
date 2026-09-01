import type { Direction, PlayerKind } from '../player.js';

/**
 * The wire vocabulary between a browser (or, next step, an agent connector) and
 * the office room. Room state itself travels as Colyseus schema patches — these
 * are the one-off messages either side sends.
 */

export const ClientMessage = {
  /** Keyboard intent changed. Sent on change, not per frame. */
  Input: 'input',
  /** Click-to-move: "route me to this tile". The server plans and drives it. */
  WalkTo: 'walk_to',
  /** Say something. Heard by anyone within CHAT_RADIUS_TILES. */
  Chat: 'chat',
  /** Update the presence line under the avatar. */
  SetStatus: 'status',
} as const;
export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

export const ServerMessage = {
  /**
   * Someone spoke nearby.
   *
   * There is deliberately no "welcome" message. Anything the server could put
   * in one is already in room state, and a message sent from `onJoin` is sent
   * before the client has had a chance to register a handler for it — it is
   * dropped every time. Identity comes from `room.sessionId` plus the players
   * map, which Colyseus replays to callbacks registered at any point.
   */
  Chat: 'chat',
  /** Something was rejected — a bad move, or the chat rate limit. */
  Error: 'error',
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

/** Keyboard intent. Components are clamped to [-1, 1] server-side. */
export interface InputPayload {
  x: number;
  y: number;
}

/** Click-to-move target, in tiles. */
export interface WalkToPayload {
  x: number;
  y: number;
}

export interface ChatSendPayload {
  text: string;
}

export interface StatusPayload {
  status: string;
}

export interface ChatBroadcastPayload {
  /** Session id of the speaker — match it against room state for position. */
  from: string;
  fromName: string;
  fromKind: PlayerKind;
  text: string;
  sentAt: number;
}

export interface ErrorPayload {
  code: 'rate_limited' | 'invalid_move' | 'invalid_message' | 'unauthorised';
  message: string;
}

/** Options passed to `joinOrCreate`. */
export interface JoinOptions {
  /** Better Auth session token, verified against the sessions table on join. */
  token: string;
  /** Which map to walk into. */
  mapId: string;
  /**
   * Which office to walk into. Rooms are keyed by this *and* the map, so two
   * offices on one deployment are two rooms and neither can see the other.
   *
   * Routing only. The server proves you belong in the office you named — a
   * member by membership, a guest by the link that let them in, an agent by
   * the office that defined it.
   */
  workspaceId: string;
}

// --- chat ------------------------------------------------------------------

/** How far a spoken message carries, in tiles. */
export const CHAT_RADIUS_TILES = 12;

/** Rate limit: this many messages per window, per player. */
export const CHAT_RATE_LIMIT = 10;
export const CHAT_RATE_WINDOW_MS = 10_000;

/** Longest message accepted. Longer ones are rejected, not truncated. */
export const CHAT_MAX_LENGTH = 280;

/** How long a speech bubble stays up. */
export const CHAT_BUBBLE_MS = 6_000;

/** How many messages the nearby-chat panel keeps. Chat is ephemeral: no DB. */
export const CHAT_LOG_LIMIT = 50;

// --- connection ------------------------------------------------------------

/** Grace period for a dropped client to rejoin in place (laptop lids close). */
export const RECONNECTION_SECONDS = 20;

/**
 * How far behind the newest patch remote avatars are rendered. One patch is
 * 50ms, so this keeps roughly two in the buffer — enough that a late or dropped
 * packet doesn't turn into a visible stutter.
 */
export const INTERPOLATION_DELAY_MS = 120;
