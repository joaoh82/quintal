'use client';

import {
  activityTerminal,
  type ActivityDetailLevel,
  type ActivityItem,
  type PublicActivity,
} from '@quintal/shared';
import { useEffect, useState } from 'react';

import {
  activityPresentation,
  collapsedActivityItems,
} from './activityPresentation';

const glyph = {
  pending: '○',
  running: '◌',
  success: '✓',
  failed: '✕',
  unknown: '?',
  cancelled: '–',
  interrupted: '!',
};
const elapsed = (start: number, end: number) =>
  `${(Math.max(0, end - start) / 1000).toFixed(1)}s`;

function Message({ item }: { item: ActivityItem }) {
  return (
    <p className="my-1 whitespace-pre-wrap break-words leading-snug text-white/90">
      {item.text}
    </p>
  );
}

function ToolStep({
  item,
  stale,
  now,
}: {
  item: ActivityItem;
  stale: boolean;
  now: number;
}) {
  return (
    <details className="my-0.5 text-xs text-white/60">
      <summary className="cursor-pointer break-words">
        <span
          className={
            item.state === 'failed'
              ? 'text-red-300'
              : item.state === 'success'
                ? 'text-emerald-300'
                : item.state === 'cancelled' || item.state === 'interrupted'
                  ? 'text-amber-200'
                  : ''
          }
        >
          {glyph[item.state]} {item.text}
        </span>{' '}
        <span className="font-mono text-[10px]">
          {stale && !item.endedAt ? 'interrupted' : item.state} ·{' '}
          {elapsed(item.startedAt, item.endedAt ?? now)}
        </span>
      </summary>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-black/15 p-2 text-[11px]">
        {item.detail || 'No result details supplied by the runtime.'}
      </pre>
    </details>
  );
}

function FullHistory({
  items,
  stale,
  now,
}: {
  items: ActivityItem[];
  stale: boolean;
  now: number;
}) {
  if (items.length === 0) return null;
  return (
    <details className="my-1 text-[11px] text-white/45">
      <summary className="cursor-pointer">Show {items.length} more activity items</summary>
      <div className="mt-1 border-l border-white/10 pl-2">
        {items.map((item) =>
          item.kind === 'message' ? (
            <Message key={item.id} item={item} />
          ) : (
            <ToolStep key={item.id} item={item} stale={stale} now={now} />
          ),
        )}
      </div>
    </details>
  );
}

export function TurnActivity({
  activity,
  detailLevel,
}: {
  activity: PublicActivity;
  detailLevel: ActivityDetailLevel;
}) {
  const [now, setNow] = useState(Date.now());
  const terminal = activityTerminal(activity.state);
  useEffect(() => {
    if (terminal) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [terminal]);
  // A lost browser connection must not leave an animated row claiming work forever.
  const stale = !terminal && now - activity.receivedAt > 360_000;
  const shownState = stale ? 'disconnected' : activity.state;
  const view = activityPresentation(activity);
  const outcomeEnd = terminal ? activity.receivedAt : now;

  // Rows shown outside the disclosure stay out of it, so changing levels
  // never paints a second copy of the same item.
  const collapsedItems = collapsedActivityItems(activity, detailLevel, view);

  return (
    <section
      className="my-1 min-w-0 border-l border-sky-300/25 pl-2"
      data-turn-id={activity.turnId}
      data-detail-level={detailLevel}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-white/45">
        <span className="text-sky-300">◆ {activity.agentName}</span>
        <span>{shownState}</span>
        <span>{elapsed(activity.startedAt, outcomeEnd)}</span>
        {!terminal && <span>last activity {elapsed(activity.updatedAt, now)} ago</span>}
      </div>

      {activity.state === 'waiting' ? (
        <p className="my-1 text-xs text-amber-200">Waiting for your input.</p>
      ) : null}

      {detailLevel === 'detailed'
        ? activity.items.map((item) =>
            item.kind === 'message' ? (
              <Message key={item.id} item={item} />
            ) : (
              <ToolStep
                key={item.id}
                item={item}
                stale={stale}
                now={outcomeEnd}
              />
            ),
          )
        : null}

      {detailLevel === 'balanced'
        ? view.messages.map((item) => <Message key={item.id} item={item} />)
        : null}

      {detailLevel === 'balanced' && view.outcomeSummary ? (
        <p className="my-1 font-mono text-[10px] text-white/45">{view.outcomeSummary}</p>
      ) : null}

      {detailLevel === 'balanced' && view.current ? (
        <ToolStep
          item={view.current}
          stale={stale}
          now={outcomeEnd}
        />
      ) : null}

      {detailLevel !== 'detailed'
        ? view.problems.map((item) => (
            <ToolStep
              key={item.id}
              item={item}
              stale={stale}
              now={outcomeEnd}
            />
          ))
        : null}

      {detailLevel !== 'detailed' ? (
        <FullHistory items={collapsedItems} stale={stale} now={outcomeEnd} />
      ) : null}

      {detailLevel === 'low' && view.finalMessage ? (
        <Message item={view.finalMessage} />
      ) : null}
    </section>
  );
}
