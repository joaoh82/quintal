'use client';

import {
  BOARD_COLORS,
  BOARD_STATUSES,
  BOARD_TITLE_MAX_LENGTH,
  boardStatusLabel,
  mayDeleteBoardItem,
  mayAssignBoardItem,
  mayWriteBoard,
  type BoardAgentRef,
  type BoardColor,
  type BoardItemRef,
  type BoardStatus,
  type RosterEntry,
} from '@quintal/shared';
import { Pin, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Board } from '../useBoard';
import {
  POSTIT_STYLES,
  ageLabel,
  columnsOf,
  matchesFilter,
  nextStatus,
  taskBadgeOf,
  wallOf,
  type BoardView,
} from './board';
import { useNow } from './useNow';

interface BoardPanelProps {
  board: Board;
  roster: RosterEntry[];
  /** The office's last refusal, shown here while this panel covers the toast. */
  notice: string;
  onClose: () => void;
  /** Open a DM with an agent, from a note it is for. */
  onMessageAgent: (agentId: string) => void;
}

/** Glyph on every agent, everywhere. Matches the roster. */
const AGENT_GLYPH = '◆';

/** `new` is the drawer with nothing in it yet; an id is a note being read or changed. */
type Drawer = { kind: 'new' } | { kind: 'item'; id: string } | null;

/**
 * The office board: the noticeboard in the hallway, as a panel.
 *
 * Issues as post-its on a wall or as three columns, a filter box, and a
 * drawer on the right for the note you are reading or writing. It owns
 * the keyboard while open, like the conversations panel, and `B` or Esc
 * closes it. Everything it shows is the office's: a note is on the board
 * when the office says so, never a moment before.
 */
export function BoardPanel({ board, roster, notice, onClose, onMessageAgent }: BoardPanelProps) {
  const [view, setView] = useState<BoardView>('kanban');
  const [query, setQuery] = useState('');
  const [drawer, setDrawer] = useState<Drawer>(null);
  const now = useNow(30_000, true);

  const canWrite = mayWriteBoard(board.you);
  const online = useMemo(
    () => new Set(roster.filter((entry) => entry.kind === 'agent').map((entry) => entry.identityId)),
    [roster],
  );

  const shown = useMemo(
    () => board.items.filter((item) => matchesFilter(item, query)),
    [board.items, query],
  );
  const selected = drawer?.kind === 'item' ? (board.items.find((item) => item.id === drawer.id) ?? null) : null;

  // A note taken down while its drawer was open is a drawer with nothing in it.
  useEffect(() => {
    if (drawer?.kind === 'item' && !selected) setDrawer(null);
  }, [drawer, selected]);

  const close = () => {
    if (drawer) setDrawer(null);
    else onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const open = (item: BoardItemRef) => setDrawer({ kind: 'item', id: item.id });

  return (
    <div
      role="dialog"
      aria-label="Office board"
      aria-modal="true"
      className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[46rem] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-white/12 bg-[#10131a]/97 text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        // Typing in a note must not reach the office's own keys: `?` is
        // help, the backtick is the conversations panel, `n` goes somewhere.
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          event.stopPropagation();
        }}
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2.5">
          <h2 className="flex items-center gap-1.5 font-mono text-sm">
            <Pin size={13} className="text-amber-300" aria-hidden />
            Office board
          </h2>
          <nav className="flex items-center gap-1 text-xs" aria-label="Board tabs">
            <Tab selected>Issues</Tab>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded border border-white/15 text-[11px]">
              <ViewButton selected={view === 'kanban'} onClick={() => setView('kanban')}>
                Columns
              </ViewButton>
              <ViewButton selected={view === 'postits'} onClick={() => setView('postits')}>
                Post-its
              </ViewButton>
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter: #12, a word, a label, an agent"
              aria-label="Filter notes"
              className="w-60 rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
            />
            {canWrite ? (
              <button
                type="button"
                onClick={() => setDrawer({ kind: 'new' })}
                className="flex items-center gap-1 rounded bg-amber-300 px-2 py-1 text-xs font-medium text-black hover:bg-amber-200"
              >
                <Plus size={12} aria-hidden /> New note
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="rounded px-2 py-0.5 font-mono text-xs text-white/50 hover:bg-white/10 hover:text-white"
              aria-label="Close"
            >
              Esc
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col">
            {!board.loaded ? (
              <p className="p-6 text-xs text-white/40">Reading the board…</p>
            ) : board.items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                <p className="text-sm text-white/70">Nothing on the board yet.</p>
                <p className="max-w-sm text-xs text-white/40">
                  {canWrite
                    ? 'Write the first note: a task, a bug, a thing somebody should look at. Hand it to an agent, or leave it for whoever picks it up.'
                    : 'Members write here. You are passing through, so you can read it.'}
                </p>
              </div>
            ) : view === 'kanban' ? (
              <Kanban items={shown} now={now} selectedId={selected?.id ?? null} online={online} onOpen={open} />
            ) : (
              <Wall items={shown} now={now} selectedId={selected?.id ?? null} online={online} onOpen={open} />
            )}
            {notice ? (
              <p role="status" className="border-t border-white/10 px-4 py-1.5 text-[11px] text-amber-200">
                {notice}
              </p>
            ) : null}
          </section>

          {drawer ? (
            <NoteDrawer
              key={drawer.kind === 'item' ? drawer.id : 'new'}
              item={selected}
              board={board}
              canWrite={canWrite}
              online={online}
              onClose={() => setDrawer(null)}
              onMessageAgent={onMessageAgent}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Tab({ selected, children }: { selected: boolean; children: React.ReactNode }) {
  return (
    <span
      role="tab"
      aria-selected={selected}
      className={`rounded px-2 py-0.5 ${selected ? 'bg-white/12 text-white' : 'text-white/55'}`}
    >
      {children}
    </span>
  );
}

function ViewButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`px-2 py-0.5 first:rounded-l last:rounded-r ${
        selected ? 'bg-white/15 text-white' : 'text-white/55 hover:bg-white/8 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

interface NotesProps {
  items: BoardItemRef[];
  now: number;
  selectedId: string | null;
  online: Set<string>;
  onOpen: (item: BoardItemRef) => void;
}

/** Three columns: what is open, what somebody is on, what is done. */
function Kanban({ items, now, selectedId, online, onOpen }: NotesProps) {
  const columns = columnsOf(items);
  return (
    <div className="grid min-h-0 flex-1 grid-cols-3 gap-3 overflow-hidden p-3">
      {BOARD_STATUSES.map((status) => (
        <div key={status} className="flex min-h-0 flex-col rounded-md border border-white/10 bg-white/3">
          <p className="flex items-baseline gap-2 border-b border-white/10 px-3 py-1.5 font-mono text-[10px] tracking-wide text-white/50 uppercase">
            {boardStatusLabel(status)}
            <span className="ml-auto text-white/35">{columns[status].length}</span>
          </p>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            {columns[status].map((item) => (
              <li key={item.id}>
                <NoteCard item={item} now={now} selected={item.id === selectedId} online={online} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The cork wall: what is pinned up, as squares. */
function Wall({ items, now, selectedId, online, onOpen }: NotesProps) {
  const pinned = wallOf(items);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#7a5a40] p-4 shadow-[inset_0_0_60px_rgba(0,0,0,0.35)]">
      {pinned.length === 0 ? (
        <p className="p-4 text-center text-xs text-white/60">Nothing pinned up. The done column has the rest.</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-4">
          {pinned.map((item) => (
            <li key={item.id}>
              <PostIt item={item} now={now} selected={item.id === selectedId} online={online} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface NoteProps {
  item: BoardItemRef;
  now: number;
  selected: boolean;
  online: Set<string>;
  onOpen: (item: BoardItemRef) => void;
}

function NoteCard({ item, now, selected, online, onOpen }: NoteProps) {
  const paint = POSTIT_STYLES[item.color];
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected || undefined}
      className={`relative w-full rounded-sm px-2.5 pt-3 pb-2 text-left shadow-md transition-transform hover:-translate-y-px ${
        selected ? 'ring-2 ring-white' : ''
      }`}
      style={{ background: paint.face, color: paint.ink }}
    >
      <span
        className="absolute top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-black/20 shadow"
        style={{ background: paint.pin }}
        aria-hidden
      />
      <span className="flex items-baseline gap-2 font-mono text-[10px] opacity-70">
        #{item.number}
        <span className="ml-auto">{ageLabel(item.updatedAt, now)}</span>
      </span>
      <span className="mt-0.5 block text-xs leading-snug font-medium">{item.title}</span>
      <Labels labels={item.labels} />
      <span className="flex items-end gap-2">
        <Assignee item={item} online={online} />
        <TaskBadge item={item} />
      </span>
    </button>
  );
}

function PostIt({ item, now, selected, online, onOpen }: NoteProps) {
  const paint = POSTIT_STYLES[item.color];
  const tilt = ((item.number * 7) % 5) - 2;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected || undefined}
      className={`relative flex aspect-square w-full flex-col rounded-sm px-3 pt-4 pb-2 text-left shadow-[2px_4px_10px_rgba(0,0,0,0.4)] transition-transform hover:scale-[1.03] hover:rotate-0 ${
        selected ? 'ring-2 ring-white' : ''
      }`}
      style={{ background: paint.face, color: paint.ink, transform: `rotate(${tilt}deg)` }}
    >
      <span
        className="absolute top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-black/25 shadow"
        style={{ background: paint.pin }}
        aria-hidden
      />
      <span className="flex items-baseline font-mono text-lg font-semibold">
        #{item.number}
        {taskBadgeOf(item) ? (
          <TaskBadge item={item} />
        ) : item.status === 'in_progress' ? (
          <span className="ml-auto rounded bg-black/15 px-1 text-[9px] font-normal tracking-wide uppercase">
            in progress
          </span>
        ) : null}
      </span>
      <span className="mt-1 line-clamp-4 text-sm leading-snug">{item.title}</span>
      <span className="mt-auto flex items-end gap-2 pt-2">
        <Assignee item={item} online={online} />
        <span className="ml-auto font-mono text-[10px] opacity-60">{ageLabel(item.updatedAt, now)}</span>
      </span>
    </button>
  );
}

function Labels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {labels.map((label) => (
        <span key={label} className="rounded-full bg-black/12 px-1.5 text-[9px] leading-4">
          {label}
        </span>
      ))}
    </span>
  );
}

function TaskBadge({ item }: { item: BoardItemRef }) {
  const badge = taskBadgeOf(item);
  if (!badge || !item.task) return null;
  const tone =
    badge === 'in review'
      ? 'bg-sky-700 text-white'
      : badge === 'merged'
        ? 'bg-emerald-700 text-white'
        : badge === 'closed'
          ? 'bg-black/30 text-white'
          : 'bg-black/15';
  const title = item.task.pr ? `${item.task.branch} · PR #${item.task.pr.number}` : item.task.branch;
  return (
    <span className={`ml-auto rounded px-1 text-[9px] font-normal tracking-wide uppercase ${tone}`} title={title}>
      {badge}
    </span>
  );
}

function Assignee({ item, online }: { item: BoardItemRef; online: Set<string> }) {
  if (!item.assignee) return null;
  const here = online.has(item.assignee.id);
  return (
    <span className="mt-1.5 flex items-center gap-1 text-[10px] opacity-80" title={here ? 'In the office' : 'Not connected'}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${here ? 'bg-emerald-500' : 'bg-black/30'}`} aria-hidden />
      {AGENT_GLYPH} {item.assignee.name}
    </span>
  );
}

interface DrawerProps {
  /** The note being read, or null for a new one. */
  item: BoardItemRef | null;
  board: Board;
  canWrite: boolean;
  online: Set<string>;
  onClose: () => void;
  onMessageAgent: (agentId: string) => void;
}

interface Draft {
  title: string;
  body: string;
  color: BoardColor;
  status: BoardStatus;
  labels: string;
  assigneeAgentId: string;
}

function draftOf(item: BoardItemRef | null): Draft {
  return {
    title: item?.title ?? '',
    body: item?.body ?? '',
    color: item?.color ?? 'yellow',
    status: item?.status ?? 'open',
    labels: item?.labels.join(', ') ?? '',
    assigneeAgentId: item?.assignee?.id ?? '',
  };
}

/**
 * The note, whole, and the form that changes it. One component for
 * reading, writing and editing: the same fields in the same places, so
 * a note looks the same whether you are about to pin it or already did.
 */
function NoteDrawer({ item, board, canWrite, online, onClose, onMessageAgent }: DrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The office's version wins: after a save, or a move by the quick button,
  // or somebody else's change, the form shows the note as it now is.
  const itemId = item?.id ?? null;
  const itemVersion = item?.updatedAt ?? 0;
  useEffect(() => {
    if (itemId) setDraft(draftOf(item));
    // `item` is read for its value at this version; the version is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, itemVersion]);
  const editing = canWrite;
  // Only your own agents are on offer: handing a note to somebody else's is
  // theirs to do. Whoever has it now stays listed, greyed, so the select can
  // show it and you can still take the note off them.
  const assignable = board.agents.filter(
    (agent: BoardAgentRef) => mayAssignBoardItem(board.you, agent) || agent.id === item?.assignee?.id,
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(item));
  const canDelete = item !== null && mayDeleteBoardItem(board.you, item);
  const moveTo = item ? nextStatus(item.status) : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (title.length === 0) return;
    const assigneeAgentId = draft.assigneeAgentId || null;
    if (!item) {
      board.create({
        title,
        body: draft.body,
        color: draft.color,
        status: draft.status,
        labels: draft.labels.split(','),
        assigneeAgentId,
      });
      onClose();
      return;
    }
    const before = draftOf(item);
    board.update({
      itemId: item.id,
      ...(title !== before.title ? { title } : {}),
      ...(draft.body !== before.body ? { body: draft.body } : {}),
      ...(draft.color !== before.color ? { color: draft.color } : {}),
      ...(draft.status !== before.status ? { status: draft.status } : {}),
      ...(draft.labels !== before.labels ? { labels: draft.labels.split(',') } : {}),
      ...(draft.assigneeAgentId !== before.assigneeAgentId ? { assigneeAgentId } : {}),
    });
  };

  const fieldClass =
    'w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none disabled:opacity-70';

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-white/10">
      <form onSubmit={submit} className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-baseline gap-2">
          <h3 className="font-mono text-sm">{item ? `#${item.number}` : 'New note'}</h3>
          {item ? (
            <span className="truncate text-[10px] text-white/40">
              {item.createdBy ? `by ${item.createdBy.name}` : ''}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded px-2 py-0.5 text-xs text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Close note"
          >
            ×
          </button>
        </div>

        <label className="flex flex-col gap-1 text-[10px] text-white/50">
          Title
          <input
            autoFocus={!item}
            value={draft.title}
            onChange={(event) => set('title', event.target.value)}
            maxLength={BOARD_TITLE_MAX_LENGTH}
            disabled={!editing}
            placeholder="What needs doing"
            className={fieldClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-[10px] text-white/50">
          Details
          <textarea
            value={draft.body}
            onChange={(event) => set('body', event.target.value)}
            disabled={!editing}
            rows={6}
            placeholder="Anything an agent would need to know to pick this up."
            className={`${fieldClass} resize-y font-sans leading-relaxed`}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-[10px] text-white/50">
            Column
            <select
              value={draft.status}
              onChange={(event) => set('status', event.target.value as BoardStatus)}
              disabled={!editing}
              className={fieldClass}
            >
              {BOARD_STATUSES.map((status) => (
                <option key={status} value={status} className="bg-[#10131a]">
                  {boardStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-white/50">
            For
            <select
              value={draft.assigneeAgentId}
              onChange={(event) => set('assigneeAgentId', event.target.value)}
              disabled={!editing}
              className={fieldClass}
            >
              <option value="" className="bg-[#10131a]">
                nobody yet
              </option>
              {assignable.map((agent: BoardAgentRef) => (
                <option
                  key={agent.id}
                  value={agent.id}
                  disabled={!mayAssignBoardItem(board.you, agent)}
                  className="bg-[#10131a]"
                >
                  {AGENT_GLYPH} {agent.name}
                  {online.has(agent.id) ? '' : ' (away)'}
                  {agent.ownerName ? ` · ${agent.ownerName}'s` : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[10px] text-white/50">
          Labels
          <input
            value={draft.labels}
            onChange={(event) => set('labels', event.target.value)}
            disabled={!editing}
            placeholder="bug, ui, priority: high"
            className={fieldClass}
          />
        </label>

        <fieldset className="flex flex-col gap-1 text-[10px] text-white/50">
          <legend>Colour</legend>
          <div className="flex gap-1.5 pt-1">
            {BOARD_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => set('color', color)}
                disabled={!editing}
                aria-label={color}
                aria-pressed={draft.color === color}
                className={`h-5 w-5 rounded-sm border ${
                  draft.color === color ? 'border-white ring-1 ring-white' : 'border-black/30'
                }`}
                style={{ background: POSTIT_STYLES[color].face }}
              />
            ))}
          </div>
        </fieldset>

        {item?.task ? (
          <div className="flex flex-col gap-0.5 text-[11px] text-white/70">
            <span className="text-[10px] text-white/50">
              {item.task.active ? 'Being worked on' : 'Was worked on'} by {item.task.agent.name}
            </span>
            <span className="font-mono text-white/80">
              {item.task.repo} · {item.task.branch}
            </span>
            {item.task.pr ? (
              <a
                href={item.task.pr.url}
                target="_blank"
                rel="noreferrer"
                className="text-sky-300 underline-offset-2 hover:underline"
              >
                PR #{item.task.pr.number} · {item.task.pr.state}
              </a>
            ) : null}
          </div>
        ) : null}

        {item?.assignee ? (
          <button
            type="button"
            onClick={() => onMessageAgent(item.assignee!.id)}
            className="self-start text-[11px] text-sky-300 underline-offset-2 hover:underline"
          >
            Message {item.assignee.name}
          </button>
        ) : null}

        {editing ? (
          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={!dirty || draft.title.trim().length === 0}
              className="rounded bg-amber-300 px-3 py-1 text-xs font-medium text-black hover:bg-amber-200 disabled:opacity-40"
            >
              {item ? 'Save' : 'Pin it'}
            </button>
            {item && moveTo ? (
              <button
                type="button"
                onClick={() => board.update({ itemId: item.id, status: moveTo })}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:bg-white/10"
              >
                → {boardStatusLabel(moveTo)}
              </button>
            ) : null}
            {canDelete ? (
              confirmingDelete ? (
                <span className="ml-auto flex items-center gap-1 text-[11px]">
                  <span className="text-white/60">Take it down?</span>
                  <button
                    type="button"
                    onClick={() => {
                      board.remove(item!.id);
                      onClose();
                    }}
                    className="rounded bg-rose-500 px-2 py-0.5 text-white hover:bg-rose-400"
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded px-2 py-0.5 text-white/60 hover:bg-white/10"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="ml-auto rounded px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/15"
                >
                  Delete
                </button>
              )
            ) : null}
          </div>
        ) : (
          <p className="mt-auto pt-2 text-[10px] text-white/35">Members write on the board. You can read it.</p>
        )}
      </form>
    </aside>
  );
}
