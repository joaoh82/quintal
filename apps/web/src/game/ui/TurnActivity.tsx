'use client';
import { activityTerminal, type PublicActivity } from '@quintal/shared';
import { useEffect, useState } from 'react';

const glyph = {
  pending: '○',
  running: '◌',
  success: '✓',
  failed: '✕',
  unknown: '?',
  cancelled: '–',
  interrupted: '!',
};
const elapsed = (start: number, end: number) => `${(Math.max(0, end - start) / 1000).toFixed(1)}s`;

export function TurnActivity({ activity }: { activity: PublicActivity }) {
  const [now, setNow] = useState(Date.now());
  const terminal = activityTerminal(activity.state);
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  // A lost browser connection must not leave an animated row claiming work forever.
  const stale = !terminal && now - activity.receivedAt > 360_000;
  return (
    <section
      className="my-1 min-w-0 border-l border-sky-300/25 pl-2"
      data-turn-id={activity.turnId}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-white/45">
        <span className="text-sky-300">◆ {activity.agentName}</span>
        <span>{stale ? 'disconnected' : activity.state}</span>
        <span>{elapsed(activity.startedAt, terminal ? activity.receivedAt : now)}</span>
        {!terminal && <span>last activity {elapsed(activity.updatedAt, now)} ago</span>}
      </div>
      {activity.items.map((item) =>
        item.kind === 'message' ? (
          <p
            key={item.id}
            className="my-1 whitespace-pre-wrap break-words leading-snug text-white/90"
          >
            {item.text}
          </p>
        ) : (
          <details key={item.id} className="my-0.5 text-xs text-white/60">
            <summary className="cursor-pointer break-words">
              <span
                className={
                  item.state === 'failed'
                    ? 'text-red-300'
                    : item.state === 'success'
                      ? 'text-emerald-300'
                      : ''
                }
              >
                {glyph[item.state]} {item.text}
              </span>{' '}
              <span className="font-mono text-[10px]">
                {stale && !item.endedAt ? 'interrupted' : item.state} ·{' '}
                {elapsed(item.startedAt, item.endedAt ?? (terminal ? activity.updatedAt : now))}
              </span>
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/15 p-2 text-[11px]">
              {item.detail || 'No result details supplied by the runtime.'}
            </pre>
          </details>
        ),
      )}
    </section>
  );
}
