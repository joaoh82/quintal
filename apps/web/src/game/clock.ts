/**
 * How much time one frame of prediction advances the local avatar by.
 *
 * The server simulates on the wall clock: a tick that comes 80ms after the
 * last one walks 80ms of distance. Prediction has to do the same, or the two
 * drift apart and the drift comes back as a correction at the end of every
 * walk. Phaser's own delta is smoothed for animation, not for simulation: it
 * averages the last ten frames, caps every frame at the 60Hz target for two
 * seconds after the window regains focus, and throws away any frame longer
 * than 200ms. On a machine painting frames slowly that adds up to a local
 * avatar that walks slower than the server's — so it starts slow after a
 * refocus and slides on after the key is released, to catch up.
 *
 * So prediction steps by the real time since the last frame, with one bound:
 * a frame that took longer than a second is not a frame to walk through, it is
 * a frozen machine, and the server will have more to say about that second
 * than a guess would.
 */
export const MAX_PREDICTION_STEP_SECONDS = 1;

export function predictionStep(rawDeltaMs: number): number {
  if (!Number.isFinite(rawDeltaMs) || rawDeltaMs <= 0) return 0;
  return Math.min(rawDeltaMs / 1000, MAX_PREDICTION_STEP_SECONDS);
}
