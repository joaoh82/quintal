'use client';

import type { ActiveWork } from '../presence';
import type { Unread } from '../unread';
import { formatElapsed } from './elapsed';

/**
 * The two small things on the right of a conversation's row.
 *
 * Buzz's sidebar answers "is anybody on it, and is there anything for me"
 * without opening a thing, and that is the whole of what these do. The
 * clock runs while agents work in the conversation — `27s`, then `(2)` when
 * more than one is at it — and the pill appears when lines have landed
 * there since you last looked. They can share a row: an agent that has
 * answered once and is still going shows both.
 */

export function WorkBadge({ work, now }: { work: ActiveWork | null; now: number }) {
  if (!work) return null;
  const others = work.agents.length > 1 ? ` (${work.agents.length})` : '';
  return (
    <span
      className="font-mono text-[10px] text-sky-300/90 tabular-nums"
      title={`${listNames(work.agents)} working`}
    >
      {formatElapsed(now - work.anchorAt)}
      {others}
    </span>
  );
}

export function UnreadPill({ unread }: { unread: Unread | undefined }) {
  if (!unread) return null;
  // A mention, or a DM, is for you: it gets the accent. The rest is traffic.
  const accent = unread.mentioned;
  if (unread.count === 0) {
    return (
      <span
        role="img"
        aria-label="Unread"
        title="Said while you were away"
        className={`inline-block h-1.5 w-1.5 rounded-full ${accent ? 'bg-sky-300' : 'bg-white/45'}`}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={`${unread.count} unread`}
      className={`rounded-full px-1.5 font-mono text-[9px] leading-4 tabular-nums ${
        accent ? 'bg-sky-300 text-black' : 'bg-white/15 text-white/85'
      }`}
    >
      {unread.count}
    </span>
  );
}

/** "Lead", "Lead and Marvin", "Lead, Marvin and Arthur". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
