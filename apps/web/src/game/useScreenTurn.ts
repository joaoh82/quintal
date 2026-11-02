'use client';

import type { PublicActivity } from '@quintal/shared';
import { useEffect, useState } from 'react';

import { gameBridge } from './bridge';
import { preferTurn } from './ui/desk';

/**
 * The turn of one agent, held for the desk panel from the moment it opens.
 *
 * The panel could read the transcripts alone, and mostly does; but a
 * transcript keeps its newest 500 lines by when they began, and a turn that
 * has run while a busy channel said 500 things has fallen off it — in the
 * one conversation that has been busiest, the screen would be blank. So
 * every step of the inspected agent is also held here, from the follow's
 * snapshot on, by the same preference the screen shows: the same turn by
 * sequence, else the running one, else the newer. Kept per agent, so a
 * click on another shows nothing of the last.
 */
export function useScreenTurn(agentId: string | null): PublicActivity | null {
  const [held, setHeld] = useState<{ agentId: string; turn: PublicActivity } | null>(null);

  useEffect(() => {
    if (!agentId) return;
    return gameBridge.on('activity', (activity) => {
      if (activity.agentId !== agentId) return;
      setHeld((current) => ({
        agentId,
        turn: preferTurn(current?.agentId === agentId ? current.turn : null, activity),
      }));
    });
  }, [agentId]);

  return held?.agentId === agentId ? held.turn : null;
}
