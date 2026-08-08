'use client';

import { useEffect, useState } from 'react';

/**
 * A timestamp that reads as "5m ago" without breaking hydration.
 *
 * The obvious version — computing the relative string during render — is a
 * hydration bug waiting to be noticed. The server renders "5m ago" at request
 * time, the client re-renders a second or two later, and React finds text that
 * doesn't match. Usually the two agree and nothing is said; occasionally they
 * straddle a boundary and the console fills with a warning about content the
 * user cannot see anything wrong with.
 *
 * So: render something *stable* first — an absolute date, identical on both
 * sides — and swap in the relative string after mount, where only the client
 * is looking. The first client render matches the server exactly by
 * construction, not by luck.
 */

function absolute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function relative(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86_400);
  return days < 30 ? `${days}d ago` : new Date(ms).toLocaleDateString();
}

interface RelativeTimeProps {
  /** Epoch milliseconds, or null when the thing never happened. */
  at: number | null;
  /** Shown instead when `at` is null — "never", "never connected". */
  never?: string;
}

export function RelativeTime({ at, never = 'never' }: RelativeTimeProps) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (at === null) return;
    setText(relative(at));
    // Re-read on a slow tick so a page left open doesn't insist it is still
    // "just now" an hour later.
    const timer = setInterval(() => setText(relative(at)), 60_000);
    return () => clearInterval(timer);
  }, [at]);

  if (at === null) return <>{never}</>;
  // `title` gives the exact time on hover, which relative text always loses.
  return <time dateTime={new Date(at).toISOString()}>{text ?? absolute(at)}</time>;
}
