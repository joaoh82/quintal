/**
 * Who is standing on the tile map. Quintal's premise is that an agent is a
 * first-class occupant of the office, not a chat bubble — so `kind` exists from
 * day one and every consumer must handle both values.
 */
export type PlayerKind = 'human' | 'agent';

/** Facing direction, used for sprite selection and (later) directional audio. */
export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * What an occupant is doing right now. Humans and agents share the vocabulary
 * so the office reads the same way for both.
 */
export type PresenceStatus =
  | 'idle'
  | 'moving'
  /** Human: talking. Agent: producing output / streaming tokens. */
  | 'speaking'
  /** Agent: running a task. Human: heads-down / do-not-disturb. */
  | 'working'
  /** Connected but not present (tabbed away, or agent between tasks). */
  | 'away'
  /** Something went wrong — agent crashed, tool call failed. */
  | 'error';

/** Authoritative per-player state, mirrored into the Colyseus room schema later. */
export interface PlayerState {
  /** Colyseus session id — unique per connection, not stable across reconnects. */
  sessionId: string;
  /**
   * Stable identity. For humans this is the `users.id`; for agents it is the
   * agent's registered id (issued by the agent gateway, not built yet).
   */
  identityId: string;
  kind: PlayerKind;
  /** Display name shown under the avatar. */
  name: string;
  /** Avatar sprite key. Resolved client-side against the sprite atlas. */
  avatar: string;
  /** Tile coordinates (not pixels). */
  x: number;
  y: number;
  direction: Direction;
  status: PresenceStatus;
  /** Id of the zone the player currently stands in, if any. */
  zoneId: string | null;
  /** Short free-text line under the name: what the agent is working on. */
  activity: string;
  /** ms since epoch of the last authoritative update. */
  updatedAt: number;
}

/** The subset a client is allowed to ask for; the server stays authoritative. */
export type PlayerInput = Pick<PlayerState, 'x' | 'y' | 'direction'>;

export function isAgent(player: Pick<PlayerState, 'kind'>): boolean {
  return player.kind === 'agent';
}
