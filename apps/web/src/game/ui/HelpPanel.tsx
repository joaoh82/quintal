'use client';

import { AGENT_COMMANDS } from '@quintal/shared';
import { useEffect } from 'react';

interface HelpPanelProps {
  onClose: () => void;
}

const KEYS: { keys: string; what: string }[] = [
  { keys: 'WASD / arrows', what: 'Walk' },
  { keys: 'Click', what: 'Walk to a tile — the server pathfinds around furniture' },
  { keys: 'Enter', what: 'Take the keyboard and type' },
  { keys: 'Esc', what: 'Give the keyboard back to the office' },
  { keys: 'M', what: 'Mute or unmute your microphone' },
  { keys: 'Space (hold)', what: 'Push to talk, then back to however it was' },
  { keys: 'Z', what: 'Show zone overlays' },
  { keys: '?', what: 'This panel' },
];

/**
 * What you can type, in one place.
 *
 * The office teaches movement by being a place you walk around in, but nothing
 * about it suggests that `!cancel` exists. Discoverability for a typed
 * convention has to be built; it is never inferred.
 */
export function HelpPanel({ onClose }: HelpPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Keys and commands"
      aria-modal="true"
      className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg border border-white/12 bg-[#10131a]/97 p-5 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-baseline gap-3">
          <h2 className="text-sm font-semibold">Keys and commands</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-xs text-white/50 hover:bg-white/10 hover:text-white"
          >
            Esc
          </button>
        </div>

        <dl className="mb-5 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          {KEYS.map((row) => (
            <div key={row.keys} className="contents">
              <dt className="font-mono text-white/70">{row.keys}</dt>
              <dd className="text-white/55">{row.what}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mb-1.5 text-xs font-semibold text-white/85">Talking</h3>
        <p className="mb-4 text-xs leading-relaxed text-white/55">
          Speech carries as far as earshot — see{' '}
          <a href="/settings" className="text-emerald-300 underline-offset-2 hover:underline">
            Settings
          </a>
          . <span className="font-mono text-white/75">@name</span> reaches someone anywhere on the
          map and opens a picker of everyone present, and their reply finds you even if you have
          walked off.
        </p>

        <h3 className="mb-1.5 text-xs font-semibold text-white/85">Voice</h3>
        <p className="mb-4 text-xs leading-relaxed text-white/55">
          You hear other people when you are close enough, and their voices fade
          with distance — the range is under{' '}
          <a href="/settings" className="text-emerald-300 underline-offset-2 hover:underline">
            Settings
          </a>
          . Your microphone starts muted every time, and nothing connects at all
          until a second person is in the office. Agents have no microphone and
          never will.
        </p>

        <h3 className="mb-1.5 text-xs font-semibold text-white/85">Agent commands</h3>
        <p className="mb-2 text-xs leading-relaxed text-white/55">
          Type <span className="font-mono text-amber-300">!</span> in chat to pick one. Only the
          agent&rsquo;s owner may use these. Add{' '}
          <span className="font-mono text-white/75">@name</span> to aim at one agent — without it,
          every agent of yours that hears it obeys.
        </p>
        <dl className="space-y-2 text-xs">
          {AGENT_COMMANDS.map((command) => (
            <div key={command.name}>
              <dt className="font-mono text-amber-300">!{command.name}</dt>
              <dd className="text-white/55">{command.detail}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
