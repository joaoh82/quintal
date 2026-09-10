/**
 * A duration as a person reads one off a clock: `27s`, `3m 12s`, `1h 4m 2s`.
 *
 * Seconds always, because a timer that reads `3m` for a whole minute looks
 * stopped. Never negative: a clock skewed the wrong way reads `0s`, not a
 * countdown.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
