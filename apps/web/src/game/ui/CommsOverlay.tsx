'use client';

import { FLOOR_ZONE_ID, FLOOR_ZONE_LABEL, channelLabel, type RosterEntry } from '@quintal/shared';
import { useEffect, useMemo } from 'react';

import { NEARBY, channelKey, parseKey, zoneKey, type Conversations } from '../useConversations';
import { ChatInput } from './ChatInput';
import { Transcript } from './Transcript';

interface CommsOverlayProps {
  conversations: Conversations;
  roster: RosterEntry[];
  /** The key that toggles this, for the hint in the corner. */
  toggleKey: string;
  onClose: () => void;
  onLeaveChannel: (channelId: string) => void;
}

/**
 * The whole office's conversations in one panel — the IRC layout, our
 * palette.
 *
 * Left: where you could be reading. Every zone on the map with who is in it,
 * then the channels you are in and the ones you could join, then your direct
 * messages. Middle: the transcript, as far back as you care to scroll. Bottom:
 * the same input as the corner box, with `/msg`, `/join` and `/leave`.
 *
 * It owns the keyboard while open — the office does not walk you around
 * while you type — and one key opens and closes it.
 */
export function CommsOverlay({
  conversations,
  roster,
  toggleKey,
  onClose,
  onLeaveChannel,
}: CommsOverlayProps) {
  const { zones, myZone, channels, available, active, activeTranscript, activeChannel } =
    conversations;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Who stands where, from the roster: the live counts on the left. */
  const occupants = useMemo(() => {
    const byZone = new Map<string, RosterEntry[]>();
    for (const entry of roster) {
      const list = byZone.get(entry.zoneId) ?? [];
      list.push(entry);
      byZone.set(entry.zoneId, list);
    }
    return byZone;
  }, [roster]);

  const zoneRows = useMemo(
    () => [
      ...zones.map((zone) => ({ id: zone.id, label: zone.label })),
      { id: FLOOR_ZONE_ID, label: FLOOR_ZONE_LABEL },
    ],
    [zones],
  );

  const { zoneId: activeZoneId } = parseKey(active);
  const activeZone = zoneRows.find((zone) => zone.id === activeZoneId) ?? null;
  const here = activeZone ? (occupants.get(activeZone.id) ?? []) : [];

  const title = activeChannel
    ? channelLabel(activeChannel)
    : activeZone
      ? activeZone.label
      : 'Nearby';
  const subtitle = activeChannel
    ? activeChannel.kind === 'dm'
      ? 'Only the two of you read this.'
      : 'Every member reads this, wherever they are.'
    : activeZone
      ? here.length === 0
        ? 'Nobody here right now.'
        : `${here.length} here · ${here.map((entry) => entry.name).join(', ')}`
      : 'Earshot of where you stand.';

  const readOnlyHint =
    activeZone && activeZone.id !== myZone
      ? `You can read ${activeZone.label} from here. Walk there to talk.`
      : undefined;

  const rowClass = (selected: boolean): string =>
    `flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs ${
      selected ? 'bg-white/12 text-white' : 'text-white/65 hover:bg-white/6 hover:text-white'
    }`;

  return (
    <div
      role="dialog"
      aria-label="Conversations"
      aria-modal="true"
      className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[46rem] w-full max-w-5xl overflow-hidden rounded-lg border border-white/12 bg-[#10131a]/97 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-white/10 py-2">
          <Section title="Zones">
            <button
              type="button"
              onClick={() => conversations.select(NEARBY)}
              className={rowClass(active === NEARBY)}
            >
              <span>nearby</span>
              <span className="ml-auto font-mono text-[10px] text-white/35">earshot</span>
            </button>
            {zoneRows.map((zone) => {
              const count = occupants.get(zone.id)?.length ?? 0;
              const selected = active === zoneKey(zone.id);
              return (
                <button
                  key={zone.id}
                  type="button"
                  onClick={() => conversations.select(zoneKey(zone.id))}
                  className={rowClass(selected)}
                >
                  <span className={zone.id === myZone ? 'text-emerald-300' : ''}>
                    {zone.label}
                  </span>
                  {zone.id === myZone ? (
                    <span className="font-mono text-[9px] text-emerald-300/70">you</span>
                  ) : null}
                  <span className="ml-auto font-mono text-[10px] text-white/35">
                    {count > 0 ? count : ''}
                  </span>
                </button>
              );
            })}
          </Section>

          <Section title="Channels">
            {channels.filter((channel) => channel.kind === 'channel').length === 0 &&
            available.length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-white/35">
                None yet. Make one in Settings → Channels.
              </p>
            ) : null}
            {channels
              .filter((channel) => channel.kind === 'channel')
              .map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => conversations.select(channelKey(channel.id))}
                  className={rowClass(active === channelKey(channel.id))}
                >
                  <span className="font-mono">{channelLabel(channel)}</span>
                </button>
              ))}
            {available.map((channel) => (
              <button
                key={channel.id}
                type="button"
                onClick={() => conversations.joinChannel(channel.slug)}
                title="Join"
                className={`${rowClass(false)} text-white/35`}
              >
                <span className="font-mono">{channelLabel(channel)}</span>
                <span className="ml-auto font-mono text-[10px]">join</span>
              </button>
            ))}
          </Section>

          <Section title="Direct messages">
            {channels.filter((channel) => channel.kind === 'dm').length === 0 ? (
              <p className="px-2 py-1 text-[11px] text-white/35">
                None open. <span className="font-mono">/msg name</span>, or Message on a card.
              </p>
            ) : null}
            {channels
              .filter((channel) => channel.kind === 'dm')
              .map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  onClick={() => conversations.select(channelKey(channel.id))}
                  className={rowClass(active === channelKey(channel.id))}
                >
                  <span className="italic">{channel.name}</span>
                </button>
              ))}
          </Section>

          <p className="mt-auto px-3 pt-3 font-mono text-[10px] leading-relaxed text-white/30">
            {toggleKey} or Esc closes · /msg · /join · /leave
          </p>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-baseline gap-3 border-b border-white/10 px-4 py-2.5">
            <h2 className={`text-sm ${activeChannel?.kind === 'dm' ? 'italic' : 'font-mono'}`}>
              {title}
            </h2>
            <span className="truncate text-[11px] text-white/45">{subtitle}</span>
            {activeChannel?.kind === 'channel' ? (
              <button
                type="button"
                onClick={() => onLeaveChannel(activeChannel.id)}
                className="ml-auto rounded px-2 py-0.5 text-[11px] text-white/45 hover:bg-white/10 hover:text-white"
              >
                leave
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className={`${activeChannel?.kind === 'channel' ? '' : 'ml-auto'} rounded px-2 py-0.5 font-mono text-xs text-white/50 hover:bg-white/10 hover:text-white`}
              aria-label="Close"
            >
              {toggleKey}
            </button>
          </header>

          <Transcript
            messages={activeTranscript.messages}
            hasMore={activeTranscript.hasMore}
            loading={activeTranscript.loading}
            onLoadEarlier={() => conversations.loadEarlier(active)}
            size="full"
            emptyText={
              activeChannel?.kind === 'dm'
                ? `Nothing between you and ${activeChannel.name} yet.`
                : activeChannel
                  ? `Nothing in ${channelLabel(activeChannel)} yet.`
                  : activeZone
                    ? `Nothing has been said in ${activeZone.label}.`
                    : 'Nothing said nearby.'
            }
          />

          {conversations.notice ? (
            <p className="px-4 py-1 text-[11px] text-amber-200/90" role="status">
              {conversations.notice}
            </p>
          ) : null}

          <ChatInput
            roster={roster}
            joinable={available.map((channel) => channel.slug)}
            focused
            autoFocus
            onSend={conversations.send}
            onFocusChange={() => {}}
            onEscape={onClose}
            placeholder={
              activeChannel?.kind === 'dm'
                ? `Message ${activeChannel.name}`
                : activeChannel
                  ? `Post in ${channelLabel(activeChannel)}`
                  : activeZone && activeZone.id !== myZone
                    ? '/msg, /join, /leave'
                    : 'Say something'
            }
            hint={readOnlyHint}
          />
        </section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 px-2">
      <p className="px-2 pb-1 font-mono text-[10px] tracking-wide text-white/35 uppercase">
        {title}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
