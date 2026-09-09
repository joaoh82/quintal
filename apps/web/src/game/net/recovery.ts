/**
 * Getting back into the office after the connection drops.
 *
 * It will drop. A laptop lid closes, a network changes, the app sits in the
 * background for an afternoon; when the person comes back they expect to walk
 * over to an agent and talk, not to find a banner that says "reconnecting"
 * and never does anything about it — which is exactly what shipped.
 *
 * Two phases, because the server offers two things. For a short window after
 * a drop it keeps the seat — avatar, position, session — and a *resume* with
 * the room's reconnection token gets it back exactly as it was. After that the
 * seat is gone and the only way in is a fresh *join*: a new session, spawned
 * at the door, but in the office. Resume is tried first because it is better;
 * join is tried forever because giving up is the one thing that must not
 * happen while the page is open.
 *
 * Pure with respect to the network and the clock so the whole policy can be
 * tested without either: everything it touches is handed in.
 */

export interface RecoveryDeps<T> {
  /** Get the old seat back. Rejects when the window has closed or the server forgot us. */
  resume: () => Promise<T>;
  /** Start over with a fresh session. Rejects while the office is unreachable. */
  join: () => Promise<T>;
  /**
   * Wait this long, or less — the caller resolves early when something worth
   * retrying for happens (the tab became visible, the network came back).
   */
  wait: (ms: number) => Promise<void>;
  now: () => number;
  /** Set once the caller no longer wants a connection; every loop checks it. */
  cancelled: () => boolean;
  /** A word to the person about what is being tried. */
  report: (phase: 'resuming' | 'rejoining', attempt: number) => void;
}

export interface RecoveryOptions {
  /** How long the server keeps the seat, in ms. Resume is not tried past this. */
  resumeWindowMs: number;
  /** Between resume attempts. Short: the window is short. */
  resumeEveryMs?: number;
  /** First pause between join attempts; doubles up to the cap. */
  joinBackoffMs?: number;
  joinBackoffCapMs?: number;
}

export type RecoveryOutcome<T> =
  | { kind: 'resumed'; room: T }
  | { kind: 'rejoined'; room: T }
  /**
   * Cancelled. `stray` is a room that arrived *after* the caller stopped
   * wanting one — an attempt was in flight when it was cancelled — and it is
   * the caller's to leave, or it stays in the office as a seat nobody holds.
   */
  | { kind: 'cancelled'; stray?: T }
  /** The join said no for a reason retrying cannot fix. */
  | { kind: 'refused'; error: unknown };

/** An error a fresh join can raise that no amount of waiting will change. */
export function isPermanent(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotSignedInError';
}

export async function recover<T>(
  deps: RecoveryDeps<T>,
  options: RecoveryOptions,
): Promise<RecoveryOutcome<T>> {
  const resumeEvery = options.resumeEveryMs ?? 1_500;
  const backoffStart = options.joinBackoffMs ?? 1_000;
  const backoffCap = options.joinBackoffCapMs ?? 15_000;

  // Phase one: the seat is still warm.
  const closes = deps.now() + options.resumeWindowMs;
  let attempt = 0;
  while (!deps.cancelled() && deps.now() < closes) {
    attempt += 1;
    deps.report('resuming', attempt);
    try {
      const room = await deps.resume();
      // Cancelled while the attempt was out: this seat is not wanted.
      if (deps.cancelled()) return { kind: 'cancelled', stray: room };
      return { kind: 'resumed', room };
    } catch {
      // The server has not noticed we dropped yet, or we are still offline.
      // Either way the answer is to ask again shortly, not to give up on the
      // seat while it is still being held.
    }
    if (deps.cancelled()) break;
    await deps.wait(Math.min(resumeEvery, Math.max(0, closes - deps.now())));
  }

  // Phase two: start over, and keep starting over.
  let pause = backoffStart;
  attempt = 0;
  while (!deps.cancelled()) {
    attempt += 1;
    deps.report('rejoining', attempt);
    try {
      const room = await deps.join();
      if (deps.cancelled()) return { kind: 'cancelled', stray: room };
      return { kind: 'rejoined', room };
    } catch (error) {
      if (isPermanent(error)) return { kind: 'refused', error };
    }
    if (deps.cancelled()) break;
    await deps.wait(pause);
    pause = Math.min(pause * 2, backoffCap);
  }

  return { kind: 'cancelled' };
}
