'use client';

import {
  AGENT_COMMANDS,
  CHAT_MAX_LENGTH,
  applyCommand,
  applyMention,
  commandQueryAt,
  mentionQueryAt,
  parseAgentCommand,
  type RosterEntry,
} from '@quintal/shared';
import { useEffect, useMemo, useRef, useState } from 'react';

import { SLASH_COMMANDS, slashQueryAt } from './slash';

/**
 * One row in the picker. People, commands and slash verbs look different and
 * complete differently, so they are a union rather than a
 * lowest-common-denominator shape that would strip what makes each worth
 * showing.
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
  | { kind: 'command'; key: string; name: string; summary: string }
  | { kind: 'slash'; key: string; text: string; summary: string };

export interface ChatInputProps {
  /** Everyone in the room, for @ autocomplete. */
  roster: RosterEntry[];
  /** Channel slugs `/join` can complete to. */
  joinable: string[];
  /** True while the input owns the keyboard. */
  focused: boolean;
  onSend: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
  /** Escape with nothing to dismiss. The corner box blurs; the overlay closes. */
  onEscape: () => void;
  placeholder: string;
  /** A line above the input about what typing here will do — or not do. */
  hint?: string | undefined;
  /** Keep focus on mount and whenever `focused` becomes true. */
  autoFocus?: boolean;
  /** Longest line accepted here: speech is short, a channel post may be a review. */
  maxLength?: number;
}

/**
 * The line you type, and the three pickers that help you type it.
 *
 * Addressing — `@` opens a filtered list of everyone present, because "type
 * the name exactly right, case be damned" is not an interface. Commands — `!`
 * opens the same list, filled with what the harness actually implements.
 * Places — `/` opens the verbs that move a line somewhere else, and completes
 * their arguments from what the office says you could join or reach.
 */
export function ChatInput({
  roster,
  joinable,
  focused,
  onSend,
  onFocusChange,
  onEscape,
  placeholder,
  hint,
  autoFocus,
  maxLength,
}: ChatInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);

  const slash = useMemo(() => slashQueryAt(draft, caret), [draft, caret]);
  // A command wins over a mention: `!shutdown @claude` should complete the verb
  // first, and `mentionQueryAt` would otherwise fight for the same caret.
  const command = useMemo(() => (slash ? null : commandQueryAt(draft, caret)), [slash, draft, caret]);
  const mention = useMemo(
    () => (slash || command ? null : mentionQueryAt(draft, caret)),
    [slash, command, draft, caret],
  );

  const candidates = useMemo<PickerItem[]>(() => {
    if (slash?.part === 'verb') {
      return SLASH_COMMANDS.filter((entry) => entry.name.startsWith(slash.query)).map((entry) => ({
        kind: 'slash',
        key: `/${entry.name}`,
        text: entry.argument ? `/${entry.name} ` : `/${entry.name}`,
        summary: entry.argument ? `${entry.summary} — /${entry.name} ${entry.argument}` : entry.summary,
      }));
    }
    if (slash?.part === 'argument') {
      if (slash.verb === 'join') {
        return joinable
          .filter((entry) => entry.startsWith(slash.query))
          .slice(0, 6)
          .map((entry) => ({ kind: 'slash', key: entry, text: `/join ${entry}`, summary: 'channel' }));
      }
      if (slash.verb === 'msg' || slash.verb === 'dm') {
        return roster
          .filter((entry) => !entry.isSelf && entry.name.toLowerCase().startsWith(slash.query))
          .slice(0, 6)
          .map((entry) => ({
            kind: 'slash',
            key: entry.sessionId,
            text: `/${slash.verb} ${entry.name}`,
            summary: entry.kind === 'agent' ? '◆ agent' : 'person',
          }));
      }
      return [];
    }
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
  }, [slash, command, mention, roster, joinable]);

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

  useEffect(() => setHighlighted(0), [slash?.query, command?.query, mention?.query]);

  // Focus is driven by state, not by whoever called first: the parent owns
  // `focused` and the DOM follows it.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if ((focused || autoFocus) && document.activeElement !== input) input.focus();
    if (!focused && !autoFocus && document.activeElement === input) input.blur();
  }, [focused, autoFocus]);

  const syncCaret = (): void => {
    const input = inputRef.current;
    if (input) setCaret(input.selectionStart ?? input.value.length);
  };

  const choose = (item: PickerItem): void => {
    // A completed slash line gets a trailing space: it closes the picker, so
    // the next Enter sends rather than re-choosing what is already there.
    const completed = item.kind === 'slash' ? `${item.text.trimEnd()} ` : '';
    const next =
      item.kind === 'slash'
        ? { text: completed, caret: completed.length }
        : item.kind === 'command'
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
  };

  return (
    <div className="relative">
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
                ) : entry.kind === 'slash' ? (
                  <>
                    <span className="font-mono text-white/85">{entry.text.trim()}</span>
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

      {hint ? (
        <p className="border-t border-white/10 px-3 py-1.5 text-[10px] text-white/45">{hint}</p>
      ) : null}

      <input
        ref={inputRef}
        value={draft}
        maxLength={maxLength ?? CHAT_MAX_LENGTH}
        placeholder={placeholder}
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
              // Typing the whole thing yourself and pressing Enter must send,
              // not "complete" to the line you already have. That was the
              // bug: `/msg Marvin` + Enter chose `/msg Marvin`, forever.
              if (
                event.key === 'Enter' &&
                picked?.kind === 'slash' &&
                picked.text.trim() === draft.trim()
              ) {
                submit();
                return;
              }
              if (picked) choose(picked);
              return;
            }
            if (event.key === 'Escape') {
              // First Escape closes the picker; a second does what Escape does.
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
            setCaret(0);
            onEscape();
          }
        }}
        className="w-full border-t border-white/10 bg-transparent px-3 py-2 text-xs text-white outline-none placeholder:text-white/30"
      />
    </div>
  );
}
