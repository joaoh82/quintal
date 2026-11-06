'use client';

import {
  BOARD_TITLE_MAX_LENGTH,
  type BoardAgentRef,
  type BoardItemRef,
  type DeskBeginPayload,
  type RosterEntry,
} from '@quintal/shared';
import { useEffect, useMemo, useState } from 'react';

import type { ConversationKey, Transcript } from '../useConversations';
import { candidates, checkoutsOf, offeredNotes } from './station';

interface StationPanelProps {
  seatId: string;
  roster: RosterEntry[];
  items: BoardItemRef[];
  /** The board's agents, for what each one's machine has checked out. */
  agents: BoardAgentRef[];
  /** What this client holds of every conversation, for the turn an agent is on and the routine it names. */
  transcripts: Record<ConversationKey, Transcript>;
  /** Your `users.id`: whose agents are offered. */
  you: string;
  /** True from Begin until the office has answered, one way or the other. */
  pending: boolean;
  onClose: () => void;
  onBegin: (payload: DeskBeginPayload) => void;
}

const fieldClass =
  'w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none disabled:opacity-70';

/**
 * The station: what an empty desk offers.
 *
 * What — a note from the board, or a title and details typed here that
 * become one — and who: one of your agents that is free. An agent on
 * something is listed greyed with what, so you can see why it is not
 * offered. Begin hands the note over the way the board does, a line in your
 * DM with the agent, and gives the agent this desk, so the turn that line
 * starts walks it here. Nothing is sent until Begin.
 */
export function StationPanel({
  seatId,
  roster,
  items,
  agents,
  transcripts,
  you,
  pending,
  onClose,
  onBegin,
}: StationPanelProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const yours = useMemo(() => candidates(roster, you, transcripts), [roster, you, transcripts]);
  const notes = useMemo(
    () => offeredNotes(items, new Set(yours.map((candidate) => candidate.entry.identityId))),
    [items, yours],
  );

  const [noteId, setNoteId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [agentId, setAgentId] = useState('');
  const [repo, setRepo] = useState('');

  const note = notes.find((item) => item.id === noteId) ?? null;
  // A note picked and then taken by somebody else is not to be begun twice.
  useEffect(() => {
    if (noteId && !note) setNoteId('');
  }, [noteId, note]);
  const chosen = yours.find((candidate) => candidate.entry.identityId === agentId && candidate.busy === '') ?? null;
  const checkouts = chosen ? checkoutsOf(agents, chosen.entry.identityId) : [];
  // A repository is this machine's: a different agent may be on a different one.
  const where = checkouts.includes(repo) ? repo : '';
  const ready = chosen !== null && (note !== null || title.trim().length > 0) && !pending;

  const begin = (): void => {
    if (!ready || !chosen) return;
    const place = where ? { repo: where } : {};
    onBegin(
      note
        ? { seatId, agentId: chosen.entry.identityId, itemId: note.id, ...place }
        : { seatId, agentId: chosen.entry.identityId, title: title.trim(), body, ...place },
    );
  };

  return (
    <aside
      className="pointer-events-auto flex max-h-full w-80 flex-col gap-2 overflow-y-auto"
      data-testid="station-panel"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          begin();
        }}
        // Letters typed here are letters, not the office's shortcuts; Escape
        // still closes, from inside a field as from outside one.
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          event.stopPropagation();
        }}
        className="flex flex-col gap-3 rounded-lg border border-white/10 bg-black/65 p-3 text-white backdrop-blur-sm"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Begin a task here</h2>
            <p className="text-[11px] text-white/50">An empty desk. Say what, and whose.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-1.5 text-white/50 hover:bg-white/10 hover:text-white"
          >
            ×
          </button>
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] uppercase tracking-wide text-white/40">What</h3>
          {notes.length > 0 ? (
            <label className="flex flex-col gap-1 text-[10px] text-white/50">
              From the board
              <select value={noteId} onChange={(event) => setNoteId(event.target.value)} className={fieldClass}>
                <option value="" className="bg-[#10131a]">
                  a new note, written below
                </option>
                {notes.map((item) => (
                  <option key={item.id} value={item.id} className="bg-[#10131a]">
                    #{item.number} {item.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-[10px] text-white/50">
            Title
            <input
              autoFocus
              value={note ? note.title : title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={BOARD_TITLE_MAX_LENGTH}
              disabled={note !== null}
              placeholder="What needs doing"
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-white/50">
            Details
            <textarea
              value={note ? note.body : body}
              onChange={(event) => setBody(event.target.value)}
              disabled={note !== null}
              rows={4}
              placeholder="Anything the agent would need to know."
              className={`${fieldClass} resize-y font-sans leading-relaxed`}
            />
          </label>
        </section>

        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] uppercase tracking-wide text-white/40">Who</h3>
          {yours.length === 0 ? (
            <p className="text-xs text-white/60">None of your agents are in the office.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {yours.map(({ entry, busy }) => (
                <li key={entry.identityId}>
                  <label
                    className={`flex items-baseline gap-2 text-xs ${busy ? 'text-white/45' : 'cursor-pointer text-white'}`}
                  >
                    <input
                      type="radio"
                      name="station-agent"
                      value={entry.identityId}
                      disabled={busy !== ''}
                      checked={agentId === entry.identityId}
                      onChange={() => setAgentId(entry.identityId)}
                    />
                    <span>◆ {entry.name}</span>
                    {busy ? <span className="truncate text-[11px]">· {busy}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>

        {checkouts.length > 0 ? (
          <label className="flex flex-col gap-1 text-[10px] text-white/50">
            Repository
            <select value={where} onChange={(event) => setRepo(event.target.value)} className={fieldClass}>
              <option value="" className="bg-[#10131a]">
                the agent&apos;s choice
              </option>
              {checkouts.map((name) => (
                <option key={name} value={name} className="bg-[#10131a]">
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="submit"
          disabled={!ready}
          className="rounded bg-sky-500/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? 'Beginning…' : 'Begin'}
        </button>
        <p className="text-[10px] leading-relaxed text-white/40">
          The note is handed over in your DM with the agent, which walks here to begin.
          {checkouts.length > 0 ? ' The repositories are what its machine has checked out.' : ' The repository is the agent\u2019s to choose.'}
        </p>
      </form>
    </aside>
  );
}
