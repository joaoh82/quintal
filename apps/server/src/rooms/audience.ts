/**
 * Who may read a turn.
 *
 * One rule, in one place, for everything that sits in a transcript beside a
 * turn: the turn's own steps, the approval card it raises, and the copy of
 * it the desk panel asks for. A turn in a channel or DM is for that
 * conversation's members. A turn in a zone is for whoever is within earshot
 * of where it began, and whoever is reading that zone from elsewhere. The
 * same question is asked the same way, so a person cannot be shown an
 * agent's steps on one path and refused them on another.
 */
export interface Viewer {
  /** Where the viewer stands, in map pixels. */
  x: number;
  y: number;
  /** Whether the viewer is a member of the turn's channel, when it has one. */
  inChannel: boolean;
  /** The zone this viewer is reading, if any. */
  followedZone: string | null;
}

export function canSeeTurn(
  turn: { channelId?: string; zoneId?: string },
  /** Where the turn began, in map pixels. Earshot is measured from there, not from where the agent has since walked. */
  at: { x: number; y: number },
  viewer: Viewer,
  radius: number,
): boolean {
  if (turn.channelId) return viewer.inChannel;
  if (viewer.followedZone && viewer.followedZone === turn.zoneId) return true;
  return Math.hypot(viewer.x - at.x, viewer.y - at.y) <= radius;
}
