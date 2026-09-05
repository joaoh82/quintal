'use client';

import { channelLabel, type RosterEntry } from '@quintal/shared';

import { NEARBY, channelKey, parseKey, type Conversations } from '../useConversations';
import { ChatInput } from './ChatInput';
import { Transcript } from './Transcript';
import { WorkingLine } from './WorkingLine';

interface ChatPanelProps {
  conversations: Conversations;
  /** True while the input owns the keyboard. */
  focused: boolean;
  /** Everyone in the room, for @ autocomplete. */
  roster: RosterEntry[];
  onFocusChange: (focused: boolean) => void;
  /** The key that opens the full panel, for the hint. */
  overlayKey: string;
  onOpenOverlay: () => void;
}

/**
 * Nearby chat, in the corner: the "where you stand" view.
 *
 * The same transcripts as the overlay, in a box the size of a sticky note.
 * It shows earshot by default and grows a tab per channel you are in, and
 * nothing more — zones you are not standing in, browsing channels, paging
 * back through a week: that is what the overlay is for, one key away.
 */
export function ChatPanel({
  conversations,
  focused,
  roster,
  onFocusChange,
  overlayKey,
  onOpenOverlay,
}: ChatPanelProps) {
  const { channels, active, select, send, transcripts } = conversations;

  // The box only ever shows nearby or a channel. A zone opened in the overlay
  // leaves the box on nearby, where it was.
  const { channelId } = parseKey(active);
  const shown = channelId ? active : NEARBY;
  const activeChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const transcript = transcripts[shown] ?? { messages: [], hasMore: false, loaded: false, loading: false };

  return (
    <div className="pointer-events-auto relative flex w-72 flex-col overflow-visible rounded-lg border border-white/10 bg-black/65 text-white backdrop-blur-sm">
      <div
        role="tablist"
        className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-2 pt-1.5 pb-1 text-[11px]"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeChannel === null}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => select(NEARBY)}
          className={`rounded px-1.5 py-0.5 ${activeChannel === null ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`}
        >
          nearby
        </button>
        {channels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            role="tab"
            aria-selected={activeChannel?.id === channel.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => select(channelKey(channel.id))}
            className={`rounded px-1.5 py-0.5 whitespace-nowrap ${activeChannel?.id === channel.id ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'} ${channel.kind === 'dm' ? 'italic' : ''}`}
          >
            {channelLabel(channel)}
          </button>
        ))}
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onOpenOverlay}
          title={`Open the full panel (${overlayKey})`}
          aria-label="Open the full panel"
          className="ml-auto rounded border border-white/15 px-1.5 font-mono leading-4 text-white/45 hover:bg-white/10 hover:text-white"
        >
          {overlayKey}
        </button>
      </div>

      <Transcript
        messages={transcript.messages}
        hasMore={false}
        loading={transcript.loading && transcript.messages.length === 0}
        onLoadEarlier={() => {}}
        size="compact"
        emptyText={
          activeChannel?.kind === 'dm'
            ? `Nothing between you and ${activeChannel.name} yet. Only the two of you read this.`
            : activeChannel
              ? `Nothing in ${channelLabel(activeChannel)} yet. Enter to post; every member reads it.`
              : 'Nothing said nearby. Enter to talk, @name to address someone, ! for agent commands.'
        }
      />

      <WorkingLine roster={roster} active={shown} myZone={conversations.myZone} size="compact" />

      <ChatInput
        roster={roster}
        joinable={conversations.available.map((channel) => channel.slug)}
        focused={focused}
        onSend={send}
        onFocusChange={onFocusChange}
        onEscape={() => onFocusChange(false)}
        placeholder={
          focused
            ? activeChannel?.kind === 'dm'
              ? `Message ${activeChannel.name} — Esc to walk`
              : activeChannel
                ? `Post in ${channelLabel(activeChannel)} — Esc to walk`
                : 'Say something — Esc to walk'
            : 'Enter to chat'
        }
      />
    </div>
  );
}
