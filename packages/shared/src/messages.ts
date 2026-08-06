import type { Direction, PlayerKind, PresenceStatus } from './player.js';

/** Messages a client (human browser or agent connector) sends to the room. */
export const ClientMessage = {
  /** Request to move to a tile. The server validates and stays authoritative. */
  Move: 'move',
  /** Change presence status / activity line. */
  SetPresence: 'presence',
  /** Local chat, scoped to the sender's proximity or zone. */
  Chat: 'chat',
  /** Explicitly enter or leave a zone (e.g. sitting at a desk). */
  EnterZone: 'zone:enter',
  LeaveZone: 'zone:leave',
} as const;
export type ClientMessage = (typeof ClientMessage)[keyof typeof ClientMessage];

/** Messages the room sends to clients. Room state itself syncs via Colyseus schema. */
export const ServerMessage = {
  /** One-off payload sent right after join (map, self identity, server time). */
  Welcome: 'welcome',
  Chat: 'chat',
  /** An occupant entered or left a zone. */
  ZoneChanged: 'zone:changed',
  /** Something an agent did, surfaced in the office activity feed. */
  AgentEvent: 'agent:event',
  /** Recoverable problem the client should surface (rate limited, move rejected). */
  Error: 'error',
} as const;
export type ServerMessage = (typeof ServerMessage)[keyof typeof ServerMessage];

export interface MovePayload {
  x: number;
  y: number;
  direction: Direction;
}

export interface PresencePayload {
  status: PresenceStatus;
  /** Short "what I'm doing" line. Empty string clears it. */
  activity: string;
}

export interface ChatPayload {
  /** Set by the server on outbound messages; ignored on inbound. */
  from?: string;
  fromKind?: PlayerKind;
  text: string;
  sentAt?: number;
}

export interface ZoneChangedPayload {
  sessionId: string;
  zoneId: string | null;
  previousZoneId: string | null;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

/** Options a client passes when joining the office room. */
export interface JoinOptions {
  /** Better Auth session token (humans) or agent token (agents). */
  token: string;
  workspaceSlug: string;
  kind: PlayerKind;
}
