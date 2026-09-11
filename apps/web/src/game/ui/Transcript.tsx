'use client';

import type { ChatBroadcastPayload, TeamRef } from '@quintal/shared';
import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';

import { segments } from './links';

/**
 * A clock time for today, the date as well for anything older. History means
 * the log can open on yesterday, and "09:12" alone would read as this morning.
 */
export function timeOf(sentAt: number): string {
  const when = new Date(sentAt);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (when.toDateString() === new Date().toDateString()) return time;
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * One line of chat, with its addresses live. Text stays text — the line is
 * whatever was typed, never markup — and each `http(s)://` or `www.` in it
 * becomes an anchor that opens away from the office: a new tab on the web,
 * the system browser in the desktop app, which sends every off-origin
 * `_blank` there. The click stays in the anchor so nothing behind the
 * transcript (the overlay's close-on-backdrop, the map) takes it as its own.
 */
function MessageText({ text, teams }: { text: string; teams: readonly TeamRef[] }) {
  return segments(
    text,
    teams.map((team) => team.name),
  ).map((segment, index) =>
    segment.kind === 'team' ? (
      <span
        key={index}
        className="rounded bg-amber-200/15 px-1 text-amber-200"
        title={describeTeam(segment.name, teams)}
      >
        {segment.text}
      </span>
    ) : segment.kind === 'link' ? (
      <a
        key={index}
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="break-all text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200 hover:decoration-sky-200"
      >
        {segment.text}
      </a>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

/** "engineering: Claude, Codex and Grok" — the tooltip on a team chip. */
function describeTeam(name: string, teams: readonly TeamRef[]): string {
  const team = teams.find((candidate) => candidate.name === name);
  const names = team?.members.map((member) => member.name) ?? [];
  if (names.length === 0) return `${name}: a team with nobody on it`;
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${name}: ${list}`;
}

interface TranscriptProps {
  messages: ChatBroadcastPayload[];
  /** The office's teams, so an `@team` in a line can say who it reached. */
  teams?: readonly TeamRef[];
  hasMore: boolean;
  loading: boolean;
  /** Called when the reader reaches the top and there is more. */
  onLoadEarlier: () => void;
  emptyText: string;
  /** The corner box is small and dense; the overlay has room. */
  size: 'compact' | 'full';
}

/**
 * The lines of one conversation, oldest at the top, and a way further back.
 *
 * Two scroll behaviours have to coexist. A reader parked at the bottom stays
 * at the bottom as lines arrive — a chat that scrolls away from you is
 * unreadable. A reader who has scrolled up to read stays where they are, and
 * when an earlier page lands above them the view does not jump: the new
 * height is added back so the line under their eye is still under their eye.
 */
export function Transcript({
  messages,
  teams,
  hasMore,
  loading,
  onLoadEarlier,
  emptyText,
  size,
}: TranscriptProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const before = useRef<{ height: number; top: number } | null>(null);
  const first = messages[0];
  const firstIdentity = first ? `${first.sentAt} ${first.fromName}` : '';

  // Remember where we were before React writes the new list.
  const log = logRef.current;
  if (log && !pinned.current) before.current = { height: log.scrollHeight, top: log.scrollTop };

  useLayoutEffect(() => {
    const element = logRef.current;
    if (!element) return;
    if (pinned.current) {
      element.scrollTop = element.scrollHeight;
    } else if (before.current) {
      // Older lines went in above: keep the same line under the eye.
      element.scrollTop = before.current.top + (element.scrollHeight - before.current.height);
    }
    before.current = null;
  }, [messages.length, firstIdentity]);

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    const onScroll = (): void => {
      const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinned.current = fromBottom < 24;
      if (element.scrollTop < 40 && hasMore && !loading) onLoadEarlier();
    };
    element.addEventListener('scroll', onScroll);
    return () => element.removeEventListener('scroll', onScroll);
  }, [hasMore, loading, onLoadEarlier]);

  const compact = size === 'compact';

  return (
    <div
      ref={logRef}
      className={
        compact
          ? 'flex max-h-40 min-h-16 flex-col gap-1 overflow-y-auto px-3 py-2 text-xs'
          : 'flex flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-3 text-[13px]'
      }
    >
      {hasMore || loading ? (
        <p className="text-center font-mono text-[10px] text-white/30">
          {loading ? 'loading…' : 'scroll up for earlier'}
        </p>
      ) : messages.length > 0 && !compact ? (
        <p className="text-center font-mono text-[10px] text-white/25">— the beginning —</p>
      ) : null}
      {messages.length === 0 && !loading ? (
        <p className={compact ? 'text-[11px] text-white/40' : 'text-xs text-white/40'}>
          {emptyText}
        </p>
      ) : (
        messages.map((message) => (
          <p key={`${message.from}-${message.sentAt}`} className="leading-snug">
            <span className="font-mono text-[10px] text-white/35">{timeOf(message.sentAt)} </span>
            <span className={message.fromKind === 'agent' ? 'text-sky-300' : 'text-emerald-300'}>
              {message.fromKind === 'agent' ? '◆ ' : ''}
              {message.fromName}
            </span>
            <span className="text-white/45">: </span>
            <span className="whitespace-pre-wrap break-words text-white/90">
              <MessageText text={message.text} teams={teams ?? []} />
            </span>
          </p>
        ))
      )}
    </div>
  );
}
