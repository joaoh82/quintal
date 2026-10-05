import type { Position } from '@quintal/shared';

import {
  RECONCILE_EASE_SECONDS,
  RECONCILE_EXACT_PX,
  RECONCILE_SNAP_PX,
} from './constants';

/** The server's last word on where we are. */
export interface Authority extends Position {
  moving: boolean;
  /** The last movement command the server had read when it said so. */
  seq: number;
}

/**
 * May prediction be corrected against this authority yet?
 *
 * Only once both sides are standing still and the server has read everything
 * we sent. Before that the authority is not wrong, it is *late*: it describes
 * where we were a round trip ago, and pulling toward it is what made the keys
 * feel slow to start and the avatar drift on after letting go. A walk ends in
 * the same place on both sides — the server starts late and stops late by the
 * same latency — so waiting costs nothing but the few pixels a tick boundary
 * can put between them.
 */
export function canSettle(
  authority: Authority | null,
  localMoving: boolean,
  sentSeq: number,
): authority is Authority {
  if (!authority || localMoving || authority.moving) return false;
  return authority.seq === sentSeq;
}

/**
 * One frame of easing prediction onto authority.
 *
 * Exponential and frame-rate independent, so a 144Hz screen and a 60Hz one
 * close the gap in the same time. A gap past the snap distance means
 * prediction was wrong rather than late, and is taken at once: sliding a whole
 * tile looks worse than a jump.
 */
export function settle(predicted: Position, authority: Position, deltaSeconds: number): Position {
  const dx = authority.x - predicted.x;
  const dy = authority.y - predicted.y;
  const error = Math.hypot(dx, dy);
  if (error > RECONCILE_SNAP_PX || error <= RECONCILE_EXACT_PX) {
    return { x: authority.x, y: authority.y };
  }
  const share = 1 - Math.exp(-deltaSeconds / RECONCILE_EASE_SECONDS);
  return { x: predicted.x + dx * share, y: predicted.y + dy * share };
}
