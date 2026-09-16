'use client';

import {
  ACTIVITY_DETAIL_LEVELS,
  type ActivityDetailLevel,
} from '@quintal/shared';
import { useState } from 'react';

import { announceActivityDetailLevel } from '@/lib/activity-preference';

import { saveActivityDetailLevelAction } from './actions';

const COPY: Record<ActivityDetailLevel, { label: string; description: string }> = {
  low: {
    label: 'Low',
    description: 'Phase and elapsed time, failures, then the final reply.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Narration, the current step and a compact outcome summary.',
  },
  detailed: {
    label: 'Detailed',
    description: 'Every tool step, status, duration and expandable result.',
  },
};

export function ActivityDetailField({
  userId,
  initialLevel,
}: {
  userId: string;
  initialLevel: ActivityDetailLevel;
}) {
  const [level, setLevel] = useState(initialLevel);
  const [saved, setSaved] = useState(initialLevel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function choose(next: ActivityDetailLevel): Promise<void> {
    if (busy || next === level) return;
    const previous = saved;
    setLevel(next);
    setBusy(true);
    setError('');
    announceActivityDetailLevel(userId, next);
    const result = await saveActivityDetailLevelAction(next);
    if (result.ok) setSaved(next);
    else {
      setLevel(previous);
      announceActivityDetailLevel(userId, previous);
      setError(result.error);
    }
    setBusy(false);
  }

  return (
    <fieldset className="space-y-3 rounded-lg border p-4" disabled={busy}>
      <legend className="px-1 text-sm font-medium">Agent activity detail</legend>
      <p className="text-muted-foreground text-xs">
        Controls how much tool activity you see. Full sanitized history stays available when
        collapsed, and this choice follows your account.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {ACTIVITY_DETAIL_LEVELS.map((option) => (
          <label
            key={option}
            className={`cursor-pointer rounded-md border p-3 text-sm ${
              level === option ? 'border-primary bg-accent' : 'hover:bg-accent/50'
            } ${busy ? 'cursor-wait opacity-70' : ''}`}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="activity-detail-level"
                value={option}
                checked={level === option}
                onChange={() => void choose(option)}
              />
              {COPY[option].label}
              {option === 'balanced' ? (
                <span className="text-muted-foreground text-[10px] font-normal uppercase">
                  default
                </span>
              ) : null}
            </span>
            <span className="text-muted-foreground mt-1 block text-xs leading-relaxed">
              {COPY[option].description}
            </span>
          </label>
        ))}
      </div>
      <p className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
        {error || (busy ? 'Saving…' : level === saved ? 'Saved for your account.' : '')}
      </p>
    </fieldset>
  );
}
