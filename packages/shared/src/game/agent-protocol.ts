import type { AgentScope } from '../agent.js';
import type { PlayerKind } from '../player.js';

/**
 * The agent gateway protocol.
 *
 * This is a **public** interface. Agents connect to the same Colyseus room as
 * humans, over the same WebSocket, and the only difference at the door is what
 * they present: `{ agentKey }` instead of a session token. Anything that speaks
 * these messages is a valid Quintal agent — an ACP harness, a Grok or Groq
 * script, thirty lines of Python. See `docs/GATEWAY.md`.
 *
 * Two rules shape the whole design:
 *
 * 1. **Agents send intent, never state.** `move_to` asks to walk somewhere; the
 *    server pathfinds and walks the avatar at human speed. There is no message
 *    that sets a position, so there is no way to teleport.
 * 2. **Nothing an agent does is invisible.** Every message below writes to
 *    `agent_events`, and everything that changes the world is also visible in
 *    the room to anyone standing nearby.
 */

// --- agent -> server -------------------------------------------------------

export const AgentMessage = {
  /** Speak. Heard by anyone within CHAT_RADIUS_TILES, badged as an agent. */
  Say: 'agent:say',
  /** Walk to a zone by id, or to a tile. Server pathfinds; no teleporting. */
  MoveTo: 'agent:move_to',
  /** Set the presence line under the nameplate. */
  SetStatus: 'agent:set_status',
  /** Who and what is around me right now. */
  LookAround: 'agent:look_around',
  /** Recent messages this agent could legitimately have heard. */
  MessagesGet: 'agent:messages_get',
  /** Read a memory slug. */
  MemoryGet: 'agent:memory_get',
  /** Write a memory slug. Over-size writes are rejected, not truncated. */
  MemorySet: 'agent:memory_set',
  /**
   * Tell the office about the machine hosting this agent: its name, where it
   * keeps repositories, which agent runtimes are installed, and where this
   * agent is rooted.
   *
   * Information only travels this way. The office cannot see anybody's PATH,
   * and a hosted Quintal never will — so a harness reporting inward is the only
   * way the settings page can show what you could actually run.
   */
  HostReport: 'agent:host_report',
} as const;
export type AgentMessage = (typeof AgentMessage)[keyof typeof AgentMessage];

export interface AgentSayPayload {
  text: string;
}

export interface AgentHostReportPayload {
  /** The machine. Hostname is enough to tell a laptop from a build box. */
  label: string;
  reposDir: string;
  /** Omitted by all but the first agent of a fleet — the answer is per machine. */
  runtimes?: { id: string; installed: boolean; path: string | null }[];
  /** Where *this* agent is rooted. */
  workspacePath: string;
  /** True when rooted at the whole repos directory rather than one checkout. */
  rootedAtReposDir: boolean;
}

/**
 * Either a zone (`{ zoneId: "agent-bay" }`) or a tile (`{ x, y }`). A zone is
 * usually what you want: zone ids are stable, tile coordinates are not.
 */
export type AgentMoveToPayload =
  | { zoneId: string; x?: never; y?: never }
  | { x: number; y: number; zoneId?: never };

export interface AgentSetStatusPayload {
  status: string;
}

/** Query messages carry a requestId; the reply comes back on `agent:result`. */
export interface AgentRequest {
  requestId: string;
}

export type AgentLookAroundPayload = AgentRequest;

export interface AgentMessagesGetPayload extends AgentRequest {
  /** `nearby` = within earshot; `zone` = everyone in the same zone. */
  scope: 'nearby' | 'zone';
  /** How many, newest last. Clamped to MESSAGES_GET_MAX. */
  n?: number;
}

export interface AgentMemoryGetPayload extends AgentRequest {
  slug: string;
}

export interface AgentMemorySetPayload extends AgentRequest {
  slug: string;
  content: string;
}

// --- server -> agent -------------------------------------------------------

export const AgentServerMessage = {
  /** Sent once, immediately after the room accepts the connection. */
  Ready: 'agent:ready',
  /** Somebody within earshot spoke. */
  NearbyChat: 'agent:nearby_chat',
  /** Somebody said this agent's name, from anywhere on the map. */
  Mention: 'agent:mention',
  /** Who is in the room, and where this agent is standing. On join and change. */
  Roster: 'agent:roster',
  /** Proof of life, so a connected agent can tell "quiet" from "dead". */
  Heartbeat: 'agent:heartbeat',
  /** Reply to a query or memory request. */
  Result: 'agent:result',
  /** A command was refused. Rate limit, missing scope, bad input. */
  Error: 'agent:error',
} as const;
export type AgentServerMessage =
  (typeof AgentServerMessage)[keyof typeof AgentServerMessage];

/** A place in the office an agent can be told to go to. */
export interface AgentZone {
  id: string;
  label: string;
  kind: string;
}

export interface AgentReadyPayload {
  agentId: string;
  sessionId: string;
  name: string;
  /** One line its owner wrote about what it does. Shown on its card. */
  description: string;
  /**
   * How its owner told it to behave.
   *
   * Sent here rather than fetched by the harness so it reaches every agent the
   * same way — one holding only its own key has no other channel — and so a
   * change lands on the next connect without waiting for a fleet poll.
   */
  instructions: string;
  /** The human accountable for this agent — the only one who may steer it. */
  ownerUserId: string;
  ownerName: string;
  scopes: AgentScope[];
  mapId: string;
  /** Where the server put this agent, in tiles. */
  tile: { x: number; y: number };
  zoneId: string | null;
  /**
   * Every zone on the map, with its id and human label.
   *
   * Without this an agent asked to "go to the Focus Room" has no way to turn
   * that into a `zoneId`, and `move_to` is only usable with raw tile
   * coordinates — which is exactly the thing the zone form exists to avoid.
   */
  zones: AgentZone[];
  serverTime: number;
  limits: {
    chatIntervalMs: number;
    moveIntervalMs: number;
    statusMaxLength: number;
    messagesGetMax: number;
    memoryMaxBytes: number;
    coreMemoryMaxBytes: number;
    /**
     * Earshot and walk-up distance, in tiles.
     *
     * These are owner-configurable, so a harness that hardcodes them answers by
     * a rule the office is no longer using. Served here rather than assumed.
     */
    chatRadiusTiles: number;
    walkUpRadiusTiles: number;
  };
}

export interface AgentChatEvent {
  from: string;
  /**
   * Stable identity of the speaker: `users.id` for a human, `agents.id` for an
   * agent. Owner-only commands are checked against this and never against the
   * display name — names are user-editable, so name matching would let anyone
   * in the workspace shut down somebody else's agent by renaming themselves.
   */
  fromUserId: string;
  fromName: string;
  fromKind: PlayerKind;
  text: string;
  /** Straight-line distance in tiles, at the moment it was said. */
  distance: number;
  sentAt: number;
}

/** A mention carries no distance: it reaches the agent from anywhere. */
export interface AgentMentionEvent {
  from: string;
  fromUserId: string;
  fromName: string;
  fromKind: PlayerKind;
  text: string;
  sentAt: number;
}

export interface AgentOccupant {
  sessionId: string;
  /** `users.id` for humans, `agents.id` for agents. */
  userId: string;
  name: string;
  kind: PlayerKind;
  status: string;
  /** Tiles away from the agent receiving this. */
  distance: number;
  zoneId: string | null;
}

export interface AgentRosterEvent {
  /** The zone the agent itself is standing in. */
  zone: { id: string; label: string; kind: string } | null;
  occupants: AgentOccupant[];
  at: number;
}

export interface AgentHeartbeatEvent {
  serverTime: number;
  /** Tiles. Where the agent is now — cheap way to confirm a move finished. */
  tile: { x: number; y: number };
  moving: boolean;
}

/** Reply to any request-carrying message. `ok` tells you which half to read. */
export type AgentResultPayload =
  | { requestId: string; ok: true; data: unknown }
  | { requestId: string; ok: false; error: AgentErrorPayload };

export interface AgentErrorPayload {
  code:
    | 'rate_limited'
    | 'missing_scope'
    | 'invalid_payload'
    | 'not_found'
    | 'too_large'
    | 'unroutable';
  message: string;
  /** Present on rate_limited: wait this long before retrying. */
  retryAfterMs?: number;
}

// --- query shapes ----------------------------------------------------------

export interface LookAroundResult {
  zone: { id: string; label: string; kind: string } | null;
  tile: { x: number; y: number };
  occupants: AgentOccupant[];
}

export interface MessagesGetResult {
  scope: 'nearby' | 'zone';
  messages: AgentChatEvent[];
}

export interface MemoryGetResult {
  slug: string;
  content: string;
  /** null when the slug has never been written. */
  updatedAt: number | null;
  bytes: number;
  limitBytes: number;
}

export interface MemorySetResult {
  slug: string;
  bytes: number;
  limitBytes: number;
}

// --- limits ----------------------------------------------------------------

/** Most messages `messages_get` will return, however many are asked for. */
export const MESSAGES_GET_MAX = 50;

/** How often the server sends a heartbeat to a connected agent. */
export const AGENT_HEARTBEAT_MS = 15_000;

/**
 * How often the server re-checks whether connected agents have been revoked.
 *
 * Revocation happens in the web app, which in development is a different
 * process from the game server, so there is no in-memory signal to listen for.
 * A short poll is the honest mechanism: an agent is kicked within this window
 * of its key being revoked, not instantly.
 */
export const AGENT_REVOCATION_POLL_MS = 5_000;

/** How many recent messages the room keeps for `messages_get`. Chat is not persisted. */
export const AGENT_MESSAGE_BUFFER = 200;
