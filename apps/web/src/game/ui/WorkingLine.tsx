'use client';

import { EMOTE_FRAMES, emoteFrames, isEmote, type RosterEntry } from '@quintal/shared';
import { useEffect, useState } from 'react';

import { EMOTE_FRAME_MS, PATHS } from '../constants';
import { workingHere } from '../presence';
import type { ConversationKey } from '../useConversations';

/** The emote sheet is 7 frames wide; drawn here at half size. */
const SHEET_COLUMNS = 7;
const GLYPH = 16;

interface WorkingLineProps {
  roster: RosterEntry[];
  active: ConversationKey;
  myZone: string;
  size: 'compact' | 'full';
}

/**
 * The line under a transcript that says who is answering in it right now.
 *
 * Buzz answers a message with an eyes reaction the moment an agent picks it
 * up; this is the same promise, with what the office already knows. The
 * balloon is the one over the agent's head on the map, the text is its
 * status line — "thinking", "reading src/index.ts", "waiting for Josh" — so
 * a real tool call reads as exactly that, and nothing is invented.
 */
export function WorkingLine({ roster, active, myZone, size }: WorkingLineProps) {
  const working = workingHere(roster, active, myZone);
  const animated = working.some((w) => isEmote(w.emote) && emoteFrames(w.emote).length > 1);
  const [tick, setTick] = useState(0);

  // Only the thinking dots animate, and only while somebody is thinking.
  useEffect(() => {
    if (!animated) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), EMOTE_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [animated]);

  if (working.length === 0) return null;

  return (
    <ul
      aria-live="polite"
      className={
        size === 'compact'
          ? 'flex flex-col gap-0.5 border-t border-white/10 px-3 py-1 text-[10px]'
          : 'flex flex-col gap-1 border-t border-white/10 px-4 py-1.5 text-[11px]'
      }
    >
      {working.map((w) => (
        <li key={w.name} className="flex items-center gap-1.5 text-white/60">
          <Glyph emote={w.emote} tick={tick} />
          <span className="text-sky-300">◆ {w.name}</span>
          {w.status ? (
            <span className="truncate font-mono text-white/45">· {w.status}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Glyph({ emote, tick }: { emote: string; tick: number }) {
  if (!isEmote(emote)) return null;
  const frames = emoteFrames(emote);
  const frame = frames[tick % frames.length] ?? frames[0];
  if (frame === undefined) return null;
  const col = frame % SHEET_COLUMNS;
  const row = Math.floor(frame / SHEET_COLUMNS);
  const rows = Math.ceil(EMOTE_FRAMES.length / SHEET_COLUMNS);
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: GLYPH,
        height: GLYPH,
        backgroundImage: `url(${PATHS.emotes})`,
        backgroundSize: `${SHEET_COLUMNS * GLYPH}px ${rows * GLYPH}px`,
        backgroundPosition: `-${col * GLYPH}px -${row * GLYPH}px`,
        imageRendering: 'pixelated',
      }}
    />
  );
}
