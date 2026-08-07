'use client';

import { CHAT_MAX_LENGTH, type ChatBroadcastPayload } from '@quintal/shared';
import { useEffect, useRef, useState } from 'react';

interface ChatPanelProps {
  messages: ChatBroadcastPayload[];
  /** True while the input owns the keyboard. */
  focused: boolean;
  onSend: (text: string) => void;
  onFocusChange: (focused: boolean) => void;
}

function timeOf(sentAt: number): string {
  return new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Nearby chat: a scrolling log plus one input.
 *
 * The focus contract with the game is the fiddly part and it lives here:
 * Enter takes the keyboard, Escape gives it back. The parent tells Phaser to
 * stop reading keys — see `OfficeScene.setInputCaptured`.
 */
export function ChatPanel({ messages, focused, onSend, onFocusChange }: ChatPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState('');

  // Focus is driven by state, not by whoever called first: the parent owns
  // `focused` and the DOM follows it. Two sources of truth here is exactly how
  // you end up typing "wasd" into the office floor.
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

  const submit = () => {
    const text = draft.trim();
    if (text.length > 0) onSend(text);
    setDraft('');
    onFocusChange(false);
  };

  return (
    <div className="pointer-events-auto flex w-72 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/65 text-white backdrop-blur-sm">
      <div
        ref={logRef}
        className="flex max-h-40 min-h-16 flex-col gap-1 overflow-y-auto px-3 py-2 text-xs"
      >
        {messages.length === 0 ? (
          <p className="text-[11px] text-white/40">
            Nothing said nearby. Press Enter to talk.
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

      <input
        ref={inputRef}
        value={draft}
        maxLength={CHAT_MAX_LENGTH}
        placeholder={focused ? 'Say something — Esc to walk' : 'Enter to chat'}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        onKeyDown={(event) => {
          // Stop every key here: otherwise Phaser's window-level listener walks
          // the avatar around while the player types.
          event.stopPropagation();
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
