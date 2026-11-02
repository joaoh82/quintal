import { emoteForStatus, idleStatus, type Pose } from '@quintal/shared';

/**
 * The glass: what a desk's monitor shows from across the room, and how its
 * holder is drawn at it. All of it from what the office already publishes —
 * the status line, the pose, the seat — so it carries no words and tells
 * nobody anything the nameplate does not. Pure, so the mapping is pinned
 * without a scene; the scene only paints.
 */

/** What the monitor shows: a colour by state, readable at a glance. */
export type GlassState = 'off' | 'idle' | 'thinking' | 'working' | 'waiting' | 'error';

/**
 * The state of a desk, from its holder. Off when nobody holds it or the
 * holder is on its feet — a screen with nobody at it is dark. Dim while the
 * holder sits on a task with nothing running. Otherwise the status line
 * decides, by the same table that picks the balloon: thinking, waiting for
 * somebody, a refusal or a stop, or a tool at work.
 */
export function glassState(holder: { status: string; pose: Pose } | null): GlassState {
  if (!holder || holder.pose === 'stand') return 'off';
  const line = holder.status.trim();
  if (holder.pose === 'sit' || idleStatus(line)) return 'idle';
  switch (emoteForStatus(line)) {
    case 'dots':
      return 'thinking';
    case 'question':
      return 'waiting';
    case 'alert':
    case 'cross':
      return 'error';
    default:
      return 'working';
  }
}

/** The pane's colour and how strongly it glows, by state. */
export const GLASS: Record<GlassState, { colour: number; alpha: number }> = {
  off: { colour: 0x000000, alpha: 0 },
  idle: { colour: 0x7c8aa5, alpha: 0.35 },
  thinking: { colour: 0x7dd3fc, alpha: 0.6 },
  working: { colour: 0x86efac, alpha: 0.6 },
  waiting: { colour: 0xfbbf24, alpha: 0.85 },
  error: { colour: 0xf87171, alpha: 0.85 },
};

/** How a holder is drawn at its desk while a tool runs. */
export interface Cue {
  /** How fast the work frames go. */
  pace: 'slow' | 'normal' | 'fast';
  /** Which frames: typing, or sitting back while something runs. */
  frames: 'work' | 'sit';
  /** A small globe over the laptop: the agent is out on the web. */
  globe: boolean;
}

const NORMAL: Cue = { pace: 'normal', frames: 'work', globe: false };

/** A shell command that runs a test suite, by the names people type. */
const TESTS = /\b(tests?|vitest|jest|pytest|mocha|rspec|cargo test|go test|tsx --test|node --test)\b/;

/**
 * The act-out for a status line, by the verb `statusForTool` chose:
 * reading and searching are slow work, editing is fast, fetching is work
 * with a globe over the laptop, and running tests is sitting back while
 * they run. Anything else — thinking, waiting, a tool with no verb of its
 * own — is drawn as the office draws it already.
 */
export function cueFor(status: string): Cue {
  const line = status.trim();
  const verb = line.slice(0, line.indexOf(' ') < 0 ? line.length : line.indexOf(' '));
  switch (verb) {
    case 'reading':
    case 'searching':
      return { ...NORMAL, pace: 'slow' };
    case 'editing':
      return { ...NORMAL, pace: 'fast' };
    case 'fetching':
      return { ...NORMAL, globe: true };
    case 'running':
      return TESTS.test(line) ? { ...NORMAL, frames: 'sit' } : NORMAL;
    default:
      return NORMAL;
  }
}

/** Two cues that would draw the same thing. */
export function sameCue(a: Cue, b: Cue): boolean {
  return a.pace === b.pace && a.frames === b.frames && a.globe === b.globe;
}
