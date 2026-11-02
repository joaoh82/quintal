'use client';

import type {
  ActivityDetailLevel,
  ActivityFollowedPayload,
  ChannelRef,
  MapZone,
  PublicActivity,
  RosterEntry,
} from '@quintal/shared';
import { useEffect, useMemo } from 'react';

import type { ConversationKey, Transcript } from '../useConversations';
import { destinations, screenTurn } from './desk';
import { AgentCard, PersonCard } from './RosterPanel';
import { TurnActivity } from './TurnActivity';

interface DeskPanelProps {
  entry: RosterEntry;
  transcripts: Record<ConversationKey, Transcript>;
  channels: ChannelRef[];
  zones: MapZone[];
  /** The agent's turn held since the panel opened; see `useScreenTurn`. */
  held: PublicActivity | null;
  /** The office's latest answer to `activity_follow`, once it has come. */
  followed: ActivityFollowedPayload | null;
  activityDetailLevel: ActivityDetailLevel;
  onClose: () => void;
  /** Open a DM with them, when the office would allow it; null otherwise, and no button is drawn. */
  onMessage: (() => void) | null;
  onOpenConversation: (key: ConversationKey) => void;
}

/**
 * What you see when you click somebody, or the screen of the desk they hold.
 *
 * For a person: their card. For an agent: its card, then the screen — the
 * turn it is on, drawn as the transcript draws it, at your detail level,
 * live — and the way to the conversation that turn is in. Built from what
 * this client already holds, which is the privacy rule applied: the office
 * sends a step only to somebody who may read the conversation it is in. A
 * turn the office withheld is a count here, never a where or a what.
 */
export function DeskPanel({
  entry,
  transcripts,
  channels,
  zones,
  held,
  followed,
  activityDetailLevel,
  onClose,
  onMessage,
  onOpenConversation,
}: DeskPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const agent = entry.kind === 'agent';
  const turn = useMemo(
    () => (agent ? screenTurn(held, transcripts, entry.identityId) : null),
    [agent, held, transcripts, entry.identityId],
  );
  const where = useMemo(
    () => (agent ? destinations(entry, turn, channels, zones) : []),
    [agent, entry, turn, channels, zones],
  );

  if (!agent) {
    return (
      <aside className="pointer-events-auto w-72" data-testid="desk-panel">
        <PersonCard person={entry} onClose={onClose} onMessage={onMessage} />
      </aside>
    );
  }

  const withheld = followed?.withheld ?? 0;

  return (
    <aside
      className="pointer-events-auto flex max-h-full w-80 flex-col gap-2 overflow-y-auto"
      data-testid="desk-panel"
    >
      <AgentCard agent={entry} onClose={onClose} onMessage={onMessage} />

      <section className="flex flex-col gap-1 rounded-lg border border-white/10 bg-black/65 p-3 text-white backdrop-blur-sm">
        <h3 className="text-[10px] uppercase tracking-wide text-white/40">On the screen</h3>
        {turn ? (
          <TurnActivity activity={turn.activity} detailLevel={activityDetailLevel} />
        ) : (
          <p className="text-xs text-white/60">
            {entry.status ? entry.status : 'Nothing running.'}
          </p>
        )}
        {withheld > 0 ? (
          <p className="text-[11px] text-white/45">
            {turn ? 'Also working' : 'Working'} in {withheld === 1 ? 'a conversation' : `${withheld} conversations`} you are not in.
          </p>
        ) : null}
        {where.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-2">
            {where.map((destination) => (
              <button
                key={destination.key}
                type="button"
                onClick={() => onOpenConversation(destination.key)}
                className="rounded border border-sky-400/30 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-400/10"
              >
                Go to {destination.label} →
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </aside>
  );
}
