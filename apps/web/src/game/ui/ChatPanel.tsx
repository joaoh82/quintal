'use client';

import {
  AGENT_COMMANDS,
  CHAT_MAX_LENGTH,
  applyCommand,
  applyMention,
  commandQueryAt,
  mentionQueryAt,
  parseAgentCommand,
  type ChatBroadcastPayload,
  type RosterEntry,
} from '@quintal/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * One row in the picker. People and commands look different and complete
 * differently, so they are a union rather than a lowest-common-denominator
 * shape that would strip what makes each worth showing.
 */
type PickerItem =
  | {
      kind: 'person';
      key: string;
      name: string;
      isAgent: boolean;
      ownerName?: string | undefined;
      status?: string | undefined;
    }
  | { kind: 'command'; key: string; name: string; summary: string };

interface ChatPanelProps {
  messages: ChatBroadcastPayload[];
  /** True while the input owns the keyboard. */
  focused: boolean;
  /** Everyone in the room, for @ autocomplete. */
  roster: RosterEntry[];
  onSend: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

/**
 * A clock time for today, the date as well for anything older. History means
 * the log can now open on yesterday, and "09:12" alone would read as this
 * morning.
 */
function timeOf(sentAt: number): string {
  const when = new Date(sentAt);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (when.toDateString() === new Date().toDateString()) return time;
  return `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Nearby chat: a scrolling log, one input, and one picker serving two sigils.
 *
 * Three contracts live here. Focus — Enter takes the keyboard, Escape gives it
 * back. Addressing — `@` opens a filtered list of everyone present, because
 * "type the name exactly right, case be damned" is not an interface, and a name
 * you can't spell is a colleague you can't reach. And commands — `!` opens the
 * same list, filled with what the harness actually implements, so the answer to
 * "what can I type at an agent" is one keystroke rather than a doc you have to
 * have read.
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

  // A command wins over a mention: `!shutdown @claude` should complete the verb
  // first, and `mentionQueryAt` would otherwise fight for the same caret.
  const command = useMemo(() => commandQueryAt(draft, caret), [draft, caret]);
  const mention = useMemo(
    () => (command ? null : mentionQueryAt(draft, caret)),
    [command, draft, caret],
  );

  const candidates = useMemo<PickerItem[]>(() => {
    if (command) {
      return AGENT_COMMANDS.filter((entry) => entry.name.startsWith(command.query)).map(
        (entry) => ({
          kind: 'command',
          key: `!${entry.name}`,
          name: entry.name,
          summary: entry.summary,
        }),
      );
    }
    if (!mention) return [];
    return roster
      .filter((entry) => !entry.isSelf)
      .filter((entry) => entry.name.toLowerCase().startsWith(mention.query))
      // Agents first: they are the ones you address by name most often, and the
      // humans near you are usually the ones you just walk up to.
      .sort((a, b) => Number(b.kind === 'agent') - Number(a.kind === 'agent'))
      .slice(0, 6)
      .map((entry) => ({
        kind: 'person',
        key: entry.sessionId,
        name: entry.name,
        isAgent: entry.kind === 'agent',
        ownerName: entry.ownerName ?? undefined,
        status: entry.status ?? undefined,
      }));
  }, [command, mention, roster]);

  const open = candidates.length > 0;

  /**
   * A typo'd command would otherwise be sent as ordinary chat, wake every agent
   * that heard it, and cost a model call to be told it means nothing. Catching
   * it in the input costs nothing and says so immediately.
   */
  const unknownCommand = useMemo(() => {
    const parsed = parseAgentCommand(draft);
    return parsed && !parsed.known ? parsed.name : null;
  }, [draft]);

  useEffect(() => setHighlighted(0), [command?.query, mention?.query]);

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

  const choose = (item: PickerItem): void => {
    const next =
      item.kind === 'command'
        ? applyCommand(draft, caret, item.name)
        : mention
          ? applyMention(draft, mention.start, caret, item.name)
          : null;
    if (!next) return;

    setDraft(next.text);
    setCaret(next.caret);
    // Put the caret after the insertion on the next tick, once React has
    // written the new value.
    requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = (): void => {
    const text = draft.trim();
    if (unknownCommand) return;
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
            Nothing said nearby. Enter to talk, @name to address someone, ! for agent commands.
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
            <li key={entry.key}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                // mousedown, not click: click fires after blur, by which point
                // the input has lost the caret we need.
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(entry);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs ${
                  index === highlighted ? 'bg-white/10' : ''
                }`}
              >
                {entry.kind === 'command' ? (
                  <>
                    <span className="font-mono text-amber-300">!{entry.name}</span>
                    <span className="ml-auto truncate text-[10px] text-white/40">
                      {entry.summary}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={entry.isAgent ? 'text-sky-300' : 'text-white/85'}>
                      {entry.isAgent ? '◆ ' : ''}
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
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {unknownCommand ? (
        <p className="border-t border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[10px] text-amber-200/90">
          <span className="font-mono">!{unknownCommand}</span> isn&rsquo;t a command. Try{' '}
          {AGENT_COMMANDS.map((entry) => `!${entry.name}`).join(', ')} — or delete the ! to say it
          out loud.
        </p>
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
              if (picked) choose(picked);
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
