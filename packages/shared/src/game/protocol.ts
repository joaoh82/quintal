import type { ChannelRef } from '../conversation.js';
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
  /** What was said in a zone before I arrived. Answered with `history`. */
  HistoryGet: 'history_get',
  /** Say something in a channel I am a member of. Not spatial: no bubble, no earshot. */
  ChannelChat: 'channel_chat',
  /** Which channels am I in. Answered with `channels`, and again whenever that changes. */
  ChannelsGet: 'channels_get',
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
  /**
   * A page of a zone's transcript, in reply to `history_get`.
   *
   * Requested rather than pushed on join, for the reason above: the client has
   * to be listening before the server speaks.
   */
  History: 'history',
  /** Somebody posted in a channel you are in. */
  ChannelChat: 'channel_chat',
  /** The channels you are in. In reply to `channels_get`, and whenever it changes. */
  Channels: 'channels',
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
  /**
   * Session id of the speaker — match it against room state for position. In
   * a `history` page it is their stable id instead: sessions do not outlive
   * the room, and a transcript does.
   */
  from: string;
  fromName: string;
  fromKind: PlayerKind;
  text: string;
  sentAt: number;
}

export interface HistoryGetPayload {
  /**
   * A zone's transcript. Omit it for what you could have heard from where
   * you stand — the nearby-chat box is an earshot box, and on arrival it
   * should hold what earshot would have held, whichever zones that crosses.
   */
  zoneId?: string;
  /** A channel's transcript instead. You have to be a member. Wins over `zoneId`. */
  channelId?: string;
  /** Only messages before this time (ms since epoch), to page back. */
  before?: number;
  /** How many. Clamped to CHAT_LOG_LIMIT. */
  n?: number;
}

export interface HistoryPayload {
  /** The zone read, or null for an earshot or channel read. */
  zoneId: string | null;
  /** The channel read, or null for a spatial read. */
  channelId: string | null;
  /** Oldest first. */
  messages: ChatBroadcastPayload[];
  /** There is more before the first message here. */
  hasMore: boolean;
}

export interface ChannelChatSendPayload {
  channelId: string;
  text: string;
}

/** A line in a channel. Same shape as spatial chat plus where it was said. */
export interface ChannelChatPayload extends ChatBroadcastPayload {
  channel: ChannelRef;
}

export interface ChannelsPayload {
  /** The channels this client is a member of. */
  channels: ChannelRef[];
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

/**
 * How many messages the nearby-chat panel keeps in memory, and the most one
 * `history_get` returns. Everything older is on the server.
 */
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
