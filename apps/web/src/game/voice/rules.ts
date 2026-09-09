import { VOICE_FRAME_MS, VOICE_LEVEL_MAX, VOICE_LEVEL_MIN, clampLevel } from '@quintal/shared';
import type { VoiceUiState } from '@quintal/shared';

/**
 * The parts of the voice client that are arithmetic, kept away from the
 * audio graph and the socket so they can be tested with numbers.
 *
 * Every rule here has a reason to be a rule rather than a magic number in
 * the pipeline: how loud is silence, how far is faint, when is somebody
 * "speaking", when is a second person close enough to be worth a socket,
 * and how late a frame may play. Each is the kind of thing that gets tuned
 * by ear later, which is exactly why it should be one function with a test.
 */

// --- loudness ----------------------------------------------------------------

/** dBov of a PCM frame: 0 is full scale, -127 is nothing at all. */
export function levelDbov(pcm: Float32Array): number {
  if (pcm.length === 0) return VOICE_LEVEL_MIN;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) sum += pcm[i]! * pcm[i]!;
  const rms = Math.sqrt(sum / pcm.length);
  if (rms <= 0) return VOICE_LEVEL_MIN;
  return clampLevel(20 * Math.log10(rms));
}

/** Below this the frame is silence and is flagged DTX. Well under room noise. */
export const DTX_THRESHOLD_DBOV = -60;

export function isSilence(level: number): boolean {
  return level <= DTX_THRESHOLD_DBOV;
}

// --- distance ------------------------------------------------------------------

/** Inside this many tiles a voice is at full volume. */
export const FULL_VOLUME_TILES = 2;

/**
 * How loud somebody is, by how far away they stand: full within two tiles,
 * fading to nothing at the edge of earshot. Volume only — whether their
 * frames arrive at all was decided by the server.
 */
export function gainFor(distanceTiles: number, radiusTiles: number): number {
  if (!Number.isFinite(distanceTiles) || distanceTiles <= FULL_VOLUME_TILES) return 1;
  if (radiusTiles <= FULL_VOLUME_TILES || distanceTiles >= radiusTiles) return 0;
  const fade = (distanceTiles - FULL_VOLUME_TILES) / (radiusTiles - FULL_VOLUME_TILES);
  // Perceptual: a straight line in gain drops too fast near the ear.
  return Math.max(0, Math.min(1, 1 - fade * fade));
}

// --- when to have a socket at all ------------------------------------------------

/** Open a little before earshot, close a little after leaving it. */
export const OPEN_MARGIN_TILES = 2;
export const CLOSE_MARGIN_TILES = 4;

/**
 * Whether the voice socket should exist, from how far the nearest other
 * human stands. Null means there is no other human — alone with agents,
 * which must cost nothing. Hysteresis so a pair on the boundary does not
 * open and close a socket twice a second.
 */
export function shouldBeOpen(
  open: boolean,
  nearestHumanTiles: number | null,
  radiusTiles: number,
): boolean {
  if (nearestHumanTiles === null) return false;
  return open
    ? nearestHumanTiles <= radiusTiles + CLOSE_MARGIN_TILES
    : nearestHumanTiles <= radiusTiles + OPEN_MARGIN_TILES;
}

// --- who is talking ---------------------------------------------------------------

export const SPEAKING_WINDOW_MS = 500;
export const SPEAKING_FRAMES = 5;

/**
 * Speaking rings come from frames, not from level: a peer is speaking when
 * enough non-silence frames arrived from them lately. Level may drive a
 * meter; it never drives this, so a miscomputed level cannot light a ring.
 */
export class SpeakingMeter {
  readonly #recent = new Map<string, number[]>();

  /** A frame from `peer` arrived. `silence` is the DTX flag on it. */
  note(peer: string, at: number, silence: boolean): void {
    if (silence) return;
    const times = this.#recent.get(peer) ?? [];
    times.push(at);
    this.#recent.set(peer, times);
  }

  forget(peer: string): void {
    this.#recent.delete(peer);
  }

  /** Who counts as speaking at `now`. */
  speaking(now: number): string[] {
    const out: string[] = [];
    for (const [peer, times] of this.#recent) {
      const fresh = times.filter((at) => now - at <= SPEAKING_WINDOW_MS);
      if (fresh.length === 0) this.#recent.delete(peer);
      else this.#recent.set(peer, fresh);
      if (fresh.length >= SPEAKING_FRAMES) out.push(peer);
    }
    return out;
  }
}

// --- when a frame plays -----------------------------------------------------------

/** Longer than this between frames is a pause, not jitter. */
const GAP_S = 0.2;

export interface JitterOptions {
  /** Target latency bounds, ms. */
  minMs?: number;
  maxMs?: number;
  /** Underruns within this window before the target grows. */
  underrunWindowMs?: number;
  underrunsToGrow?: number;
  /** A calm stretch this long shrinks the target. */
  calmMs?: number;
}

/**
 * When to play the next frame from one peer, in audio-clock seconds.
 *
 * Frames arrive with jitter; playback must be smooth. So each peer has a
 * cursor that advances one frame per frame, held a target latency ahead of
 * the clock. A frame that arrives after its slot is late — an underrun — and
 * the cursor restarts from now plus the target. A few underruns in a row grow
 * the target, up to the cap; a calm stretch shrinks it back toward the floor.
 * Adaptive between 40 and 200 ms, the way the plan asked, and no cleverer.
 */
export class JitterScheduler {
  #cursor: number | null = null;
  #target: number;
  readonly #min: number;
  readonly #max: number;
  readonly #window: number;
  readonly #toGrow: number;
  readonly #calm: number;
  readonly #underruns: number[] = [];
  #lastGrowOrUnderrun = 0;
  #lastNow: number | null = null;
  underruns = 0;

  constructor(options: JitterOptions = {}) {
    this.#min = (options.minMs ?? 40) / 1000;
    this.#max = (options.maxMs ?? 200) / 1000;
    this.#window = (options.underrunWindowMs ?? 5_000) / 1000;
    this.#toGrow = options.underrunsToGrow ?? 3;
    this.#calm = (options.calmMs ?? 10_000) / 1000;
    this.#target = this.#min * 1.5;
  }

  /** The current target latency, seconds. */
  get target(): number {
    return this.#target;
  }

  /** The audio-clock time at which the next frame should start. */
  next(now: number): number {
    const frame = VOICE_FRAME_MS / 1000;

    // A pause in the frames — the sender went quiet, DTX — is not the
    // network being late. Restart the cadence without blaming the buffer.
    const gap = this.#lastNow !== null && now - this.#lastNow > GAP_S;
    this.#lastNow = now;

    if (this.#cursor === null || this.#cursor < now) {
      if (this.#cursor !== null && !gap) {
        this.underruns += 1;
        this.#underruns.push(now);
        this.#lastGrowOrUnderrun = now;
        const recent = this.#underruns.filter((at) => now - at <= this.#window);
        this.#underruns.splice(0, this.#underruns.length, ...recent);
        if (recent.length >= this.#toGrow) {
          this.#target = Math.min(this.#max, this.#target * 1.5);
          this.#underruns.length = 0;
        }
      }
      this.#cursor = now + this.#target;
    } else if (this.#cursor - now > this.#target + 0.1) {
      // Far ahead: the sender's clock ran fast or a burst arrived. Pull in
      // rather than let the ear fall a growing fraction of a second behind.
      this.#cursor = now + this.#target;
    }

    if (now - this.#lastGrowOrUnderrun > this.#calm && this.#target > this.#min) {
      this.#target = Math.max(this.#min, this.#target * 0.8);
      this.#lastGrowOrUnderrun = now;
    }

    const playAt = this.#cursor;
    this.#cursor += frame;
    return playAt;
  }

  reset(): void {
    this.#cursor = null;
  }
}

export const LEVEL_RANGE = { min: VOICE_LEVEL_MIN, max: VOICE_LEVEL_MAX } as const;

// --- the button ------------------------------------------------------------------

/** What the microphone button says, and in which colour. */
export interface MicButton {
  label: string;
  tone: 'muted' | 'ready' | 'live';
}

/**
 * The button reports the switch, not the wire.
 *
 * Alone with agents there is no socket, so nothing is sent whatever the
 * switch says — and a button that derived its word from "is audio flowing"
 * read "Muted" to somebody who had just pressed M, and could never read
 * anything else while they stood alone. So: muted is the person's choice
 * and says so; live is the wire's and says so; unmuted with nobody to hear
 * is "Unmuted", and the socket line beside it says why nothing flows.
 * Push-to-talk held counts as unmuted for as long as the key is down.
 */
export function micButton(state: Pick<VoiceUiState, 'muted' | 'talking' | 'mic'>): MicButton {
  if (state.mic === 'live') return { label: state.talking ? 'Talking' : 'Mic live', tone: 'live' };
  if (state.muted && !state.talking) return { label: 'Muted', tone: 'muted' };
  return { label: 'Unmuted', tone: 'ready' };
}
