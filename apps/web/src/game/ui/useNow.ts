'use client';

import { useEffect, useState } from 'react';

/**
 * The time, re-read on a cadence — for a timer that has to visibly move.
 *
 * Off unless asked for: a page with no clock on it should not re-render
 * every second for nothing, so `enabled` is false when there is nothing to
 * count and the value simply stays put.
 */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs]);

  return now;
}
