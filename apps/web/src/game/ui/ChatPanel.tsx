'use client';

import {
  CHAT_MAX_LENGTH,
  applyMention,
  mentionQueryAt,
  type ChatBroadcastPayload,
  type RosterEntry,
} from '@quintal/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

interface ChatPanelProps {
  messages: ChatBroadcastPayload[];
  /** True while the input owns the keyboard. */
  focused: boolean;
  /** Everyone in the room, for @ autocomplete. */
  roster: RosterEntry[];
  onSend: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

function timeOf(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Nearby chat: a scrolling log, one input, and an `@` picker.
 *
 * Two contracts live here. The focus one — Enter takes the keyboard, Escape
 * gives it back — and the addressing one: `@` opens a filtered list of everyone
 * present, because "type the name exactly right, case be damned" is not an
 * interface, and a name you can't spell is a colleague you can't reach.
 */
export function ChatPanel({
  messages,
  focused,
  roster,
  onSend,
  onFocusChange,
}: ChatPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);

  const mention = useMemo(() => mentionQueryAt(draft, caret), [draft, caret]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    return roster
      .filter((entry) => !entry.isSelf)
      .filter((entry) => entry.name.toLowerCase().startsWith(mention.query))
      // Agents first: they are the ones you address by name most often, and the
      // humans near you are usually the ones you just walk up to.
      .sort((a, b) => Number(b.kind === 'agent') - Number(a.kind === 'agent'))
      .slice(0, 6);
  }, [mention, roster]);

  const open = mention !== null && candidates.length > 0;

  useEffect(() => setHighlighted(0), [mention?.query]);

  // Focus is driven by state, not by whoever called first: the parent owns
  // `focused` and the DOM follows it.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (focused && document.activeElement !== input) input.focus();
    if (!focused && document.activeElement === input) input.blur();
  }, [focused]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages]);

  const syncCaret = (): void => {
    const input = inputRef.current;
    if (input) setCaret(input.selectionStart ?? input.value.length);
  };

  const choose = (name: string): void => {
    if (!mention) return;
    const next = applyMention(draft, mention.start, caret, name);
    setDraft(next.text);
    setCaret(next.caret);
    // Put the caret after the inserted name on the next tick, once React has
    // written the new value.
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = (): void => {
    const text = draft.trim();
    if (text.length > 0) onSend(text);
    setDraft('');
    setCaret(0);
    onFocusChange(false);
  };

  return (
    <div className="pointer-events-auto relative flex w-72 flex-col overflow-visible rounded-lg border border-white/10 bg-black/65 text-white backdrop-blur-sm">
      <div
        ref={logRef}
        className="flex max-h-40 min-h-16 flex-col gap-1 overflow-y-auto px-3 py-2 text-xs"
      >
        {messages.length === 0 ? (
          <p className="text-[11px] text-white/40">
            Nothing said nearby. Enter to talk, @name to address someone.
          </p>
        ) : (
          messages.map((message) => (
            <p key={`${message.from}-${message.sentAt}`} className="leading-snug">
              <span className="font-mono text-[10px] text-white/35">
                {timeOf(message.sentAt)}{' '}
              </span>
              <span className={message.fromKind === 'agent' ? 'text-sky-300' : 'text-emerald-300'}>
                {message.fromKind === 'agent' ? '◆ ' : ''}
                {message.fromName}
              </span>
              <span className="text-white/45">: </span>
              <span className="text-white/90">{message.text}</span>
            </p>
          ))
        )}
      </div>

      {open ? (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 mb-1 w-full overflow-hidden rounded-md border border-white/15 bg-[#10131a]/95 shadow-lg backdrop-blur"
        >
          {candidates.map((entry, index) => (
            <li key={entry.sessionId}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                // mousedown, not click: click fires after blur, by which point
                // the input has lost the caret we need.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(entry.name);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs ${
                  index === highlighted ? 'bg-white/10' : ''
                }`}
              >
                <span className={entry.kind === 'agent' ? 'text-sky-300' : 'text-white/85'}>
                  {entry.kind === 'agent' ? '◆ ' : ''}
                  {entry.name}
                </span>
                {entry.ownerName ? (
                  <span className="text-[10px] text-white/35">{entry.ownerName}&rsquo;s</span>
                ) : null}
                {entry.status ? (
                  <span className="ml-auto truncate font-mono text-[10px] text-white/40">
                    {entry.status}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <input
        ref={inputRef}
        value={draft}
        maxLength={CHAT_MAX_LENGTH}
        placeholder={focused ? 'Say something — Esc to walk' : 'Enter to chat'}
        onChange={(event) => {
          setDraft(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={(event) => {
          // Stop every key here: otherwise Phaser's window-level listener walks
          // the avatar around while the player types.
          event.stopPropagation();

          if (open) {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setHighlighted((current) => (current + 1) % candidates.length);
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setHighlighted((current) => (current - 1 + candidates.length) % candidates.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              const picked = candidates[highlighted];
              if (picked) choose(picked.name);
              return;
            }
            if (event.key === 'Escape') {
              // First Escape closes the picker; a second gives the keyboard
              // back to the office.
              event.preventDefault();
              setCaret(-1);
              return;
            }
          }

          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft('');
            onFocusChange(false);
          }
        }}
        className="border-t border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none placeholder:text-white/30 focus:bg-black/60"
      />
    </div>
  );
}
