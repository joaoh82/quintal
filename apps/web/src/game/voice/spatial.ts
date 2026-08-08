import { VOICE_HYSTERESIS_TILES } from '@quintal/shared';

/**
 * The maths of proximity audio, kept away from LiveKit and WebAudio so it can
 * be tested without either.
 *
 * Everything here is in tiles, matching every other radius in Quintal.
 */

/** Straight-line distance between two points, in tiles. */
export function distanceTiles(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Should we be subscribed to this person, given whether we already are?
 *
 * The asymmetry is the whole point. Subscribe when you come inside the radius;
 * unsubscribe only once you are well outside it. A single threshold means
 * standing on the line toggles the subscription every time somebody breathes
 * on the keyboard — audible as clipping, and a stream of pointless signalling.
 */
export function shouldSubscribe(
  distance: number,
  radiusTiles: number,
  subscribed: boolean,
): boolean {
  return subscribed
    ? distance <= radiusTiles + VOICE_HYSTERESIS_TILES
    : distance < radiusTiles;
}

/** Tiles within which someone is at full volume, before falloff begins. */
export const FULL_VOLUME_TILES = 2;

/**
 * Volume for a voice this far away: full up close, fading to nothing at the
 * edge.
 *
 * Linear rather than inverse-square. Physically wrong and deliberately so —
 * true falloff is almost all silence across most of the range, which in a room
 * this size reads as "broken" rather than "distant".
 */
export function gainFor(distance: number, radiusTiles: number): number {
  if (distance <= FULL_VOLUME_TILES) return 1;
  if (distance >= radiusTiles) return 0;
  const span = radiusTiles - FULL_VOLUME_TILES;
  return span <= 0 ? 0 : 1 - (distance - FULL_VOLUME_TILES) / span;
}

/**
 * Where to place a voice in the stereo field, relative to the listener.
 *
 * Scaled so somebody at the edge of earshot sits near the side rather than
 * fractionally off-centre, and clamped: a voice panned fully to one ear is
 * disorienting rather than spatial. Y maps to `z` because the office is
 * top-down — somebody "below" you on screen is behind you in the room.
 */
export function pannerPosition(
  listener: { x: number; y: number },
  speaker: { x: number; y: number },
  radiusTiles: number,
): { x: number; y: number; z: number } {
  const scale = radiusTiles <= 0 ? 1 : 1 / radiusTiles;
  const clamp = (value: number): number => Math.max(-1, Math.min(1, value * scale));
  return { x: clamp(speaker.x - listener.x), y: 0, z: clamp(speaker.y - listener.y) };
}

/** Who we should be hearing, and how, this tick. */
export interface VoiceTarget {
  identityId: string;
  distance: number;
  gain: number;
  position: { x: number; y: number; z: number };
}

/**
 * Resolve the whole room to a set of subscription decisions.
 *
 * Agents are absent by construction rather than by a filter at the call site:
 * they have no microphone, now or ever, and a media path that could carry one
 * is a design mistake waiting for someone to make it.
 */
export function resolveTargets(
  occupants: readonly {
    identityId: string;
    kind: string;
    x: number;
    y: number;
    isSelf: boolean;
  }[],
  radiusTiles: number,
  subscribed: ReadonlySet<string>,
): { hear: VoiceTarget[]; drop: string[] } {
  const me = occupants.find((occupant) => occupant.isSelf);
  if (!me) return { hear: [], drop: [...subscribed] };

  const hear: VoiceTarget[] = [];
  const keep = new Set<string>();

  for (const occupant of occupants) {
    if (occupant.isSelf || occupant.kind === 'agent') continue;

    const distance = distanceTiles(me, occupant);
    if (!shouldSubscribe(distance, radiusTiles, subscribed.has(occupant.identityId))) continue;

    keep.add(occupant.identityId);
    hear.push({
      identityId: occupant.identityId,
      distance,
      gain: gainFor(distance, radiusTiles),
      position: pannerPosition(me, occupant, radiusTiles),
    });
  }

  return { hear, drop: [...subscribed].filter((id) => !keep.has(id)) };
}

/** True once a second human is present — the moment voice becomes worth a connection. */
export function needsVoice(
  occupants: readonly { kind: string; isSelf: boolean }[],
): boolean {
  return occupants.filter((occupant) => occupant.kind !== 'agent').length >= 2;
}
