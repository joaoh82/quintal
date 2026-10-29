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
  type BoardGithubRef,
  type BoardItemRef,
  type BoardStatus,
  type BoardTaskRef,
  type ChannelRef,
  type MapZone,
  type PullRequestAction,
  type RepoPullsRef,
  type RosterEntry,
} from '@quintal/shared';
import { ExternalLink, GitPullRequest, Pin, Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { Board } from '../useBoard';
import { runtimeLines } from './agentRuntime';
import {
  POSTIT_STYLES,
  ageLabel,
  agentMatches,
  agentRowsOf,
  branchesWithoutPr,
  checksLabel,
  columnsOf,
  matchesFilter,
  mergeableLabel,
  nextStatus,
  pullActionConfirm,
  pullActionLabel,
  pullRowActionsOf,
  DEFAULT_PULL_FILTERS,
  PULL_STATUS_FILTERS,
  pullAuthorsOf,
  pullListMatches,
  pullListOf,
  pullProjectsOf,
  pullStateOf,
  reviewLabel,
  taskBadgeOf,
  wallOf,
  type AgentRow,
  type BoardTab,
  type PullFilters,
  type PullListRow,
  type PullStatusFilter,
  type BoardView,
} from './board';
import { formatElapsed } from './elapsed';
import { useNow } from './useNow';

interface BoardPanelProps {
  board: Board;
  roster: RosterEntry[];
  /** The office's last refusal, shown here while this panel covers the toast. */
  notice: string;
  onClose: () => void;
  /** Open a DM with an agent, from a note it is for. */
  onMessageAgent: (agentId: string) => void;
  /** Every zone on the map, to say where an agent is in words. */
  zones: MapZone[];
  /** The channels and DMs the viewer is in, to name where an agent is working. */
  channels: ChannelRef[];
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
export function BoardPanel({ board, roster, notice, onClose, onMessageAgent, zones, channels }: BoardPanelProps) {
  const [tab, setTab] = useState<BoardTab>('issues');
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
  const agentRows = useMemo(
    () => agentRowsOf(board.agents, roster, board.items, board.tasks, zones, channels, now).filter((row) => agentMatches(row, query)),
    [board.agents, board.items, board.tasks, roster, zones, channels, now, query],
  );
  const [pullFilters, setPullFilters] = useState<PullFilters>(DEFAULT_PULL_FILTERS);
  const allPulls = useMemo(
    () => pullListOf(board.pulls.pulls, board.tasks, board.githubHost, board.reviews),
    [board.pulls.pulls, board.tasks, board.githubHost, board.reviews],
  );
  const pulls = useMemo(
    () => allPulls.filter((row) => pullListMatches(row, pullFilters, query)),
    [allPulls, pullFilters, query],
  );
  const reviewers = useMemo(
    () => board.agents.filter((agent) => agent.ownerUserId === board.you.userId),
    [board.agents, board.you.userId],
  );
  const onBranch = useMemo(() => branchesWithoutPr(board.tasks), [board.tasks]);

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
          <nav className="flex items-center gap-1 text-xs" role="tablist" aria-label="Board tabs">
            <Tab selected={tab === 'issues'} onClick={() => setTab('issues')}>
              Issues
            </Tab>
            <Tab selected={tab === 'agents'} onClick={() => setTab('agents')}>
              Agents
            </Tab>
            <Tab selected={tab === 'pulls'} onClick={() => setTab('pulls')}>
              Pull requests
            </Tab>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {tab === 'pulls' && canWrite ? (
              board.github.connected ? (
                <button
                  type="button"
                  onClick={() => board.refreshPulls()}
                  className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/10"
                  title={`Ask GitHub now, as ${board.github.login ? `@${board.github.login}` : 'the office'}`}
                >
                  <RefreshCw size={11} aria-hidden /> Check GitHub
                </button>
              ) : (
                <a href="/settings" className="text-[11px] text-white/45 underline-offset-2 hover:text-white/80 hover:underline">
                  Connect GitHub in Settings → Office
                </a>
              )
            ) : null}
            {tab === 'issues' ? (
              <div className="flex rounded border border-white/15 text-[11px]">
                <ViewButton selected={view === 'kanban'} onClick={() => setView('kanban')}>
                  Columns
                </ViewButton>
                <ViewButton selected={view === 'postits'} onClick={() => setView('postits')}>
                  Post-its
                </ViewButton>
              </div>
            ) : null}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                tab === 'issues'
                  ? 'Filter: #12, a word, a label, an agent'
                  : tab === 'agents'
                    ? 'Filter: a name, a status, a branch'
                    : 'Filter: #12, a title, a branch, a person'
              }
              aria-label="Filter"
              className="w-60 rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
            />
            {canWrite && tab === 'issues' ? (
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
            ) : tab === 'agents' ? (
              <AgentsTab
                rows={agentRows}
                now={now}
                guest={board.you.role === null}
                onOpenNote={(id) => setDrawer({ kind: 'item', id })}
                onMessage={onMessageAgent}
                you={board.you.userId}
              />
            ) : tab === 'pulls' ? (
              <PullsTab
                rows={pulls}
                allRows={allPulls}
                filters={pullFilters}
                onFilters={setPullFilters}
                onBranch={onBranch}
                now={now}
                guest={board.you.role === null}
                github={board.github}
                host={board.githubHost}
                listing={board.pulls}
                reviewers={reviewers}
                onOpenNote={(id) => setDrawer({ kind: 'item', id })}
                onAct={(taskId, action, expectedHeadSha) => board.actOnPull({ taskId, action, expectedHeadSha })}
                onRefresh={(taskId) => board.refreshPulls(taskId)}
                onRequestReview={(agentId, url) => board.requestReview(agentId, url)}
              />
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

function Tab({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded px-2 py-0.5 ${selected ? 'bg-white/12 text-white' : 'text-white/55 hover:bg-white/8 hover:text-white'}`}
    >
      {children}
    </button>
  );
}

/** The state of a pull request as a chip, in the colour the board uses for the same word on a note. */
function PrState({ state }: { state: 'open' | 'merged' | 'closed' }) {
  const tone =
    state === 'merged'
      ? 'border-purple-300/40 text-purple-200'
      : state === 'open'
        ? 'border-emerald-300/40 text-emerald-200'
        : 'border-white/25 text-white/55';
  return <span className={`rounded border px-1 font-mono text-[9px] tracking-wide uppercase ${tone}`}>{state}</span>;
}

/**
 * Every agent of the office, here or not. The office's rows say whose each
 * is and what it last left; the roster says what the ones here are doing
 * now. An agent that is away is still a row — its notes are still its
 * notes — so nobody wonders where the work went when it disconnected.
 * Each row opens onto what the agent was on before, from the ledger.
 */
function AgentsTab({
  rows,
  now,
  guest,
  onOpenNote,
  onMessage,
  you,
}: {
  rows: AgentRow[];
  now: number;
  /** A guest is not sent the ledger, so it has no history to show. */
  guest: boolean;
  onOpenNote: (itemId: string) => void;
  onMessage: (agentId: string) => void;
  you: string;
}) {
  /** Which agents have their history open. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (agentId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });

  if (rows.length === 0) {
    return <p className="p-6 text-xs text-white/40">No agents in this office yet, or none match the filter. Agents are made in Settings.</p>;
  }
  return (
    <ul className="min-h-0 flex-1 divide-y divide-white/8 overflow-y-auto">
      {rows.map((row) => {
        const running = row.here ? runtimeLines(row.here) : null;
        const away = row.here === null;
        const open = expanded.has(row.agent.id);
        return (
          <li key={row.agent.id} className={`px-4 py-2.5 text-xs ${away ? 'text-white/55' : ''}`}>
            <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1fr)] gap-x-4">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${away ? 'bg-white/25' : 'bg-emerald-400'}`} aria-hidden />
                  <span className={away ? 'text-sky-200/70' : 'text-sky-300'}>
                    {AGENT_GLYPH} {row.agent.name}
                  </span>
                  <span className="truncate text-[10px] text-white/40">{row.agent.ownerName ? `${row.agent.ownerName}'s` : ''}</span>
                </p>
                {row.agent.description ? <p className="mt-0.5 truncate text-[11px] text-white/45">{row.agent.description}</p> : null}
                <p className="mt-0.5 font-mono text-[10px] text-white/35">
                  {away
                    ? row.lastSeenAt === null
                      ? 'never connected'
                      : `away · last seen ${ageLabel(row.lastSeenAt, now)}`
                    : row.workingSince > 0
                      ? `working for ${formatElapsed(now - row.workingSince)}`
                      : 'here, idle'}
                </p>
                {running ? (
                  <p className="font-mono text-[10px] text-white/35">
                    {running.runtime} · {running.model}
                  </p>
                ) : row.agent.runtimeId ? (
                  <p className="font-mono text-[10px] text-white/35">
                    {row.agent.runtimeId} · {row.agent.modelId ?? 'default'}
                    {row.agent.hostLabel ? ` · ${row.agent.hostLabel}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="min-w-0">
                {row.status ? <p className="truncate font-mono text-[11px] text-white/70">{row.status}</p> : <p className="text-white/30">—</p>}
                {row.where ? <p className="mt-0.5 truncate text-[10px] text-white/40">in {row.where}</p> : null}
              </div>
              <div className="min-w-0">
                {row.task ? (
                  <p className="truncate">
                    {row.task.title}
                    {' · '}
                    <span className="font-mono text-white/60">{row.task.branch}</span>
                    {row.task.pr ? (
                      <>
                        {' '}
                        <a href={row.task.pr.url} target="_blank" rel="noreferrer" className="text-sky-200 underline-offset-2 hover:underline">
                          PR #{row.task.pr.number}
                        </a>{' '}
                        <PrState state={row.task.pr.state} />
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-white/30">on no task</p>
                )}
                {row.notes.length > 0 ? (
                  <p className="mt-0.5 flex flex-wrap gap-1">
                    {row.notes.map((note) => (
                      <button
                        key={note.id}
                        type="button"
                        onClick={() => onOpenNote(note.id)}
                        title={note.title}
                        className="rounded border border-amber-300/30 px-1 font-mono text-[10px] text-amber-200/90 hover:bg-amber-300/10"
                      >
                        #{note.number}
                      </button>
                    ))}
                  </p>
                ) : null}
              </div>
              <div className="flex items-start justify-end gap-3">
                {guest ? null : (
                  <button
                    type="button"
                    onClick={() => toggle(row.agent.id)}
                    aria-expanded={open}
                    aria-controls={`agent-history-${row.agent.id}`}
                    disabled={row.history.length === 0}
                    title={row.history.length === 0 ? 'Nothing earlier in the ledger' : undefined}
                    className="text-[11px] text-white/60 underline-offset-2 enabled:hover:underline disabled:text-white/25"
                  >
                    {open ? 'Hide history' : `History · ${row.history.length}`}
                  </button>
                )}
                {row.agent.ownerUserId === you ? (
                  <button
                    type="button"
                    onClick={() => onMessage(row.agent.id)}
                    className="text-[11px] text-sky-300 underline-offset-2 hover:underline"
                  >
                    Message
                  </button>
                ) : null}
              </div>
            </div>
            {open && row.history.length > 0 ? (
              <AgentHistory id={`agent-history-${row.agent.id}`} lines={row.history} now={now} onOpenNote={onOpenNote} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What an agent was on before, from the office's ledger: each branch it
 * said it was on, what it was for, and how its pull request ended. The
 * board carries each agent's newest ended lines, not the whole ledger.
 */
function AgentHistory({
  id,
  lines,
  now,
  onOpenNote,
}: {
  id: string;
  lines: BoardTaskRef[];
  now: number;
  onOpenNote: (itemId: string) => void;
}) {
  return (
    <ol id={id} className="mt-2 space-y-1 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
      {lines.map((line) => (
        <li key={line.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_auto] items-baseline gap-x-4">
          <p className="min-w-0 truncate">
            <span className="text-white/80">{line.title}</span>
            {' · '}
            <span className="font-mono text-[11px] text-white/50">
              {line.repo} · {line.branch}
            </span>
          </p>
          <p className="min-w-0 truncate">
            {line.pr ? (
              <>
                <a href={line.pr.url} target="_blank" rel="noreferrer" className="text-sky-200 underline-offset-2 hover:underline">
                  PR #{line.pr.number}
                </a>{' '}
                <PrState state={pullStateOf(line)} />{' '}
              </>
            ) : null}
            {line.item ? (
              <button
                type="button"
                onClick={() => onOpenNote(line.item!.id)}
                title={line.item.title}
                className="rounded border border-amber-300/30 px-1 font-mono text-[10px] text-amber-200/90 hover:bg-amber-300/10"
              >
                #{line.item.number}
              </button>
            ) : null}
            {!line.pr && !line.item ? <span className="text-white/30">no pull request</span> : null}
          </p>
          <p className="text-right font-mono text-[10px] text-white/40" title={new Date(line.startedAt).toLocaleString()}>
            {line.status === 'active' ? `still open · heard ${ageLabel(line.lastSeenAt, now)}` : `ended ${ageLabel(line.endedAt ?? line.lastSeenAt, now)}`}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Every pull request the office knows: each of its repositories' as GitHub
 * lists them, whoever opened them, and the ledger's, joined. A row from an
 * agent's task shows what the office checked — the harness's word until
 * GitHub has been asked, GitHub's after — and, for a member of an office
 * with a token, the few things to do about it, each in two clicks. Any open
 * one can be handed to one of your agents to review, and the row says who
 * was. Its number or title shows the whole of it on hover; a click on the
 * title keeps that open under the row.
 */
function PullsTab({
  rows,
  allRows,
  filters,
  onFilters,
  onBranch,
  now,
  guest,
  github,
  host,
  listing,
  reviewers,
  onOpenNote,
  onAct,
  onRefresh,
  onRequestReview,
}: {
  /** The rows that answer the pickers and the filter box. */
  rows: PullListRow[];
  /** Every row, for what the pickers offer. */
  allRows: PullListRow[];
  filters: PullFilters;
  onFilters: (filters: PullFilters) => void;
  onBranch: BoardTaskRef[];
  now: number;
  /** A guest is not sent the ledger: say so rather than that nothing was heard. */
  guest: boolean;
  github: BoardGithubRef;
  /** The office's GitHub host, for reading pull request URLs. */
  host: string;
  /** When the repositories were last listed, and which would not be. */
  listing: RepoPullsRef;
  /** The viewer's own agents: the ones they may ask for a review. */
  reviewers: BoardAgentRef[];
  onOpenNote: (itemId: string) => void;
  onAct: (taskId: string, action: PullRequestAction, expectedHeadSha: string | undefined) => void;
  onRefresh: (taskId: string) => void;
  onRequestReview: (agentId: string, url: string) => void;
}) {
  /** Which row has something open under it: its details, its actions, or the review picker. */
  const [open, setOpen] = useState<{ key: string; what: 'details' | 'actions' | 'review' } | null>(null);
  /** The row whose card is up on hover, and what it hangs from. */
  const [hover, setHover] = useState<{ key: string; anchor: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const showHover = (key: string, target: HTMLElement) => {
    keepHover();
    setHover({ key, anchor: target.getBoundingClientRect() });
  };
  const leaveHover = () => {
    keepHover();
    hoverTimer.current = setTimeout(() => setHover(null), PULL_CARD_LINGER_MS);
  };
  useEffect(() => keepHover, []);
  const hovered = hover && open?.key !== hover.key ? rows.find((row) => row.key === hover.key) : undefined;
  const [confirm, setConfirm] = useState<{ taskId: string; action: PullRequestAction } | null>(null);
  /** A row acted on, until the office sends the board again. */
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    setBusy(null);
    setConfirm(null);
  }, [allRows]);

  const authors = useMemo(() => pullAuthorsOf(allRows), [allRows]);
  const projects = useMemo(() => pullProjectsOf(allRows, github), [allRows, github]);

  const act = (task: BoardTaskRef, action: PullRequestAction) => {
    setBusy(task.id);
    setConfirm(null);
    setOpen(null);
    onAct(task.id, action, task.github?.headSha || undefined);
  };
  const toggle = (key: string, what: 'details' | 'actions' | 'review') => {
    setOpen(open?.key === key && open.what === what ? null : { key, what });
    setConfirm(null);
    setHover(null);
  };

  if (guest) {
    return <p className="p-6 text-xs text-white/40">The office's pull requests are for its members. Ask to be let in.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-1.5 text-[11px]">
        <Picker
          label="Status"
          value={filters.status}
          onChange={(status) => onFilters({ ...filters, status: status as PullStatusFilter })}
          options={PULL_STATUS_FILTERS.map((status) => ({ value: status, label: status === 'all' ? 'any status' : status }))}
        />
        <Picker
          label="Author"
          value={filters.author}
          onChange={(author) => onFilters({ ...filters, author })}
          options={[{ value: '', label: 'anybody' }, ...authors]}
        />
        <Picker
          label="Project"
          value={filters.project}
          onChange={(project) => onFilters({ ...filters, project })}
          options={[{ value: '', label: 'every project' }, ...projects.map((repo) => ({ value: repo, label: repo }))]}
        />
        <span className="ml-auto font-mono text-[10px] text-white/35">
          {!github.connected
            ? 'Only the ledger’s: give the office a GitHub token in Settings → Office → GitHub to list its repositories.'
            : listing.fetchedAt === null
              ? 'Listing the office’s repositories…'
              : `${github.repos.length} ${github.repos.length === 1 ? 'repository' : 'repositories'} listed ${ageLabel(listing.fetchedAt, now)}`}
          {listing.errors.length > 0 ? (
            <span className="text-rose-300/80" title={listing.errors.map((error) => `${error.repo}: ${error.message}`).join('\n')}>
              {' '}
              · {listing.errors.length} would not list
            </span>
          ) : null}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="p-6 text-xs text-white/40">
          {allRows.length === 0
            ? 'No pull requests yet. One appears here when an agent on a task opens one, or when one is opened in a repository on the office’s GitHub list.'
            : 'No pull requests match. Try another status, author or project.'}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-white/8 overflow-y-auto" onScroll={() => setHover(null)}>
          {rows.map((row) => {
            const task = row.task;
            // `row.repo` is lower-case `owner/name`, as the office's list is.
            const onList = github.connected && github.repos.includes(row.repo);
            const actions = onList ? pullRowActionsOf(row, github, host) : [];
            const live = task?.github?.known ? task.github : null;
            const checks = live ? checksLabel(live.checks) : null;
            const review = live ? reviewLabel(live.reviewDecision) : null;
            const pending = task && confirm?.taskId === task.id ? confirm.action : null;
            const mayReview = row.state === 'open' && reviewers.length > 0 && (onList || task !== null);
            const showing = open?.key === row.key ? open.what : null;
            return (
              <li key={row.key} className={`px-4 py-2 text-xs ${task && busy === task.id ? 'opacity-60' : ''}`}>
                <div className="grid grid-cols-[3.5rem_minmax(0,2fr)_minmax(0,1.2fr)_auto_auto] items-center gap-x-4">
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noreferrer"
                    onMouseEnter={(event) => showHover(row.key, event.currentTarget)}
                    onMouseLeave={leaveHover}
                    className="flex items-center gap-1 font-mono text-sky-200 underline-offset-2 hover:underline"
                  >
                    <GitPullRequest size={12} aria-hidden />#{row.number}
                  </a>
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => toggle(row.key, 'details')}
                      onMouseEnter={(event) => showHover(row.key, event.currentTarget)}
                      onMouseLeave={leaveHover}
                      aria-expanded={showing === 'details'}
                      className="block w-full truncate text-left text-white/85 hover:text-white"
                    >
                      {row.title}
                    </button>
                    <p className="truncate font-mono text-[10px] text-white/45">
                      {row.repo} · {row.headRef}
                      {row.listed?.baseRef || live?.baseRef ? ` → ${row.listed?.baseRef || live?.baseRef}` : ''}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate">
                      {row.author ? <span className="text-white/70">@{row.author}</span> : null}
                      {row.author && row.agentName ? <span className="text-white/30"> · </span> : null}
                      {row.agentName ? (
                        <span className="text-sky-300/90">
                          {AGENT_GLYPH} {row.agentName}
                        </span>
                      ) : null}
                    </p>
                    {task?.item ? (
                      <button
                        type="button"
                        onClick={() => onOpenNote(task.item!.id)}
                        className="truncate text-[10px] text-amber-200/90 underline-offset-2 hover:underline"
                        title={task.item.title}
                      >
                        note #{task.item.number} {task.item.title}
                      </button>
                    ) : (
                      <p className="text-[10px] text-white/30">{task ? 'no note' : 'no agent task'}</p>
                    )}
                    {row.reviews.length > 0 ? (
                      <p
                        className="truncate text-[10px] text-violet-200/90"
                        title={row.reviews.map((review) => `${review.agentName}, asked by ${review.byName} ${ageLabel(review.at, now)}`).join('\n')}
                      >
                        <span className="text-white/40">reviewer </span>
                        {row.reviews.map((review) => `${AGENT_GLYPH} ${review.agentName}`).join(', ')}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="flex items-center gap-1.5">
                      {checks ? <Chip tone={checks.tone}>{checks.text}</Chip> : null}
                      {review ? <Chip tone={review === 'approved' ? 'good' : 'bad'}>{review}</Chip> : null}
                      {row.draft ? <Chip tone="none">draft</Chip> : null}
                      <PrState state={row.state} />
                    </span>
                    <span className="font-mono text-[10px] text-white/35">
                      {live
                        ? `GitHub · ${mergeableLabel(live)} · checked ${ageLabel(live.fetchedAt, now)}`
                        : row.listed
                          ? `updated ${ageLabel(row.listed.updatedAt, now)}`
                          : `heard ${ageLabel(row.updatedAt, now)}`}
                      {task?.github?.error ? <span className="text-rose-300/80"> · {task.github.known ? 'last check failed' : task.github.error}</span> : null}
                      {github.connected && !onList ? <span title="Not on the office’s GitHub list. An owner or admin adds repositories in Settings → Office → GitHub."> · not on the office’s list</span> : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {mayReview ? (
                      <button
                        type="button"
                        onClick={() => toggle(row.key, 'review')}
                        aria-expanded={showing === 'review'}
                        className="rounded border border-sky-300/30 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-300/10"
                        title="Ask one of your agents to review it"
                      >
                        Review
                      </button>
                    ) : null}
                    {task && actions.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggle(row.key, 'actions')}
                        disabled={busy === task.id}
                        aria-expanded={showing === 'actions'}
                        className="rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/10 disabled:opacity-50"
                      >
                        Actions
                      </button>
                    ) : null}
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[11px] text-white/80 hover:bg-white/10"
                    >
                      Open <ExternalLink size={11} aria-hidden />
                    </a>
                  </div>
                </div>
                {showing === 'details' ? (
                  <div className="mt-2 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
                    <PullDetails row={row} now={now} />
                  </div>
                ) : null}
                {showing === 'review' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
                    <span className="text-white/60">Ask for a review of #{row.number}:</span>
                    {reviewers.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => {
                          setOpen(null);
                          onRequestReview(agent.id, row.url);
                        }}
                        className="rounded border border-sky-300/30 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-300/10"
                      >
                        {AGENT_GLYPH} {agent.name}
                      </button>
                    ))}
                    <span className="ml-auto text-[10px] text-white/35">It lands in your DM with the agent, which reviews on GitHub.</span>
                  </div>
                ) : null}
                {task && showing === 'actions' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
                    {pending ? (
                      <>
                        <span className="text-white/80">{pullActionConfirm(task, pending)}</span>
                        <button
                          type="button"
                          onClick={() => act(task, pending)}
                          className={`rounded px-2 py-1 text-[11px] font-medium ${pending === 'close' ? 'bg-rose-300 text-black hover:bg-rose-200' : 'bg-emerald-300 text-black hover:bg-emerald-200'}`}
                        >
                          Yes, {pullActionLabel(pending).toLowerCase()}
                        </button>
                        <button type="button" onClick={() => setConfirm(null)} className="rounded px-2 py-1 text-[11px] text-white/60 hover:bg-white/10">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        {actions.map((action) => (
                          <button
                            key={action}
                            type="button"
                            onClick={() => setConfirm({ taskId: task.id, action })}
                            className={`rounded border px-2 py-1 text-[11px] hover:bg-white/10 ${action === 'close' ? 'border-rose-300/30 text-rose-200' : 'border-white/15 text-white/80'}`}
                          >
                            {pullActionLabel(action)}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(null);
                            onRefresh(task.id);
                          }}
                          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-white/50 hover:bg-white/10 hover:text-white/80"
                        >
                          <RefreshCw size={10} aria-hidden /> Check again
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {hover && hovered ? <PullHoverCard row={hovered} anchor={hover.anchor} now={now} onKeep={keepHover} onLeave={leaveHover} /> : null}
      {onBranch.length > 0 ? (
        <p className="border-t border-white/10 px-4 py-1.5 text-[11px] text-white/40">
          {onBranch.length === 1
            ? `1 task on a branch with no pull request yet: ${onBranch[0]!.agentName} on ${onBranch[0]!.branch}.`
            : `${onBranch.length} tasks on a branch with no pull request yet.`}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled drop-down for the Pull requests tab's filters. */
function Picker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-1 text-white/45">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-44 rounded border border-white/15 bg-[#161a24] px-1.5 py-0.5 text-[11px] text-white/85 focus:border-white/40 focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A small fact on a row: the checks, the review, a draft. */
function Chip({ tone, children }: { tone: 'good' | 'bad' | 'wait' | 'none'; children: ReactNode }) {
  const colour =
    tone === 'good'
      ? 'border-emerald-300/40 text-emerald-200'
      : tone === 'bad'
        ? 'border-rose-300/40 text-rose-200'
        : tone === 'wait'
          ? 'border-amber-300/40 text-amber-200'
          : 'border-white/20 text-white/50';
  return <span className={`rounded border px-1 font-mono text-[9px] tracking-wide ${colour}`}>{children}</span>;
}

/**
 * Everything the office knows about one pull request, for the card a row
 * shows on hover and under itself when its title is clicked: its title in
 * full, where it goes, who opened it and who was asked to review it, and —
 * for one an agent's task opened — what GitHub said when the office last
 * asked (the checks by name, mergeability, the review, who last acted on it
 * from here) or, before it has, what the harness last reported, said
 * plainly so a state read here is never mistaken for GitHub's.
 */
function PullDetails({ row, now }: { row: PullListRow; now: number }) {
  const task = row.task;
  const live = task?.github?.known ? task.github : null;
  const base = row.listed?.baseRef || live?.baseRef || '';
  const checks = live?.checks ?? null;
  return (
    <div className="text-[11px] text-white/80">
      <p className="flex items-center gap-2">
        <span className="font-mono text-sky-200">#{row.number}</span>
        <PrState state={row.state} />
        {row.draft ? <Chip tone="none">draft</Chip> : null}
        <span className="ml-auto truncate font-mono text-[10px] text-white/45">{row.repo}</span>
      </p>
      <p className="mt-1.5 text-[13px] leading-snug break-words text-white/90">{row.title}</p>
      <p className="mt-1 truncate font-mono text-[10px] text-white/50">
        {row.headRef}
        {base ? ` → ${base}` : ''}
      </p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-white/10 pt-2">
        <dt className="text-white/40">opened by</dt>
        <dd className="truncate">
          {row.author ? <span>@{row.author}</span> : null}
          {row.author && row.agentName ? <span className="text-white/30"> · </span> : null}
          {row.agentName ? (
            <span className="text-sky-300/90">
              {AGENT_GLYPH} {row.agentName}
            </span>
          ) : null}
          {!row.author && !row.agentName ? <span className="text-white/40">unknown</span> : null}
        </dd>
        <dt className="text-white/40">reviewer</dt>
        <dd>
          {row.reviews.length === 0 ? (
            <span className="text-white/40">no agent asked</span>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {row.reviews.map((review) => (
                <li key={review.agentId} className="truncate">
                  <span className="text-violet-200">
                    {AGENT_GLYPH} {review.agentName}
                  </span>
                  <span className="text-white/40">
                    {' '}
                    asked by {review.byName}, {ageLabel(review.at, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </dd>
        {task ? (
          <>
            <dt className="text-white/40">task</dt>
            <dd className="truncate">{task.title}</dd>
            <dt className="text-white/40">note</dt>
            <dd className="truncate">{task.item ? `#${task.item.number} ${task.item.title}` : 'none'}</dd>
          </>
        ) : null}
        {live ? (
          <>
            <dt className="text-white/40">merge</dt>
            <dd>{mergeableLabel(live)}</dd>
            <dt className="text-white/40">review</dt>
            <dd>{reviewLabel(live.reviewDecision) ?? 'none yet'}</dd>
            {live.lastAction ? (
              <>
                <dt className="text-white/40">from here</dt>
                <dd>
                  {pullActionLabel(live.lastAction.action).toLowerCase()} by {live.lastAction.byName}, {ageLabel(live.lastAction.at, now)}
                </dd>
              </>
            ) : null}
            <dt className="text-white/40">head</dt>
            <dd className="truncate font-mono text-white/60">{live.headSha.slice(0, 10)}</dd>
          </>
        ) : null}
        {row.listed ? (
          <>
            <dt className="text-white/40">opened</dt>
            <dd>{ageLabel(row.listed.createdAt, now)}</dd>
          </>
        ) : task ? (
          <>
            <dt className="text-white/40">started</dt>
            <dd>{ageLabel(task.startedAt, now)}</dd>
          </>
        ) : null}
        <dt className="text-white/40">updated</dt>
        <dd>{ageLabel(row.updatedAt, now)}</dd>
      </dl>
      {checks && checks.total > 0 ? (
        <div className="mt-2 border-t border-white/10 pt-2">
          <p className={checks.summary === 'passing' ? 'text-emerald-300' : checks.summary === 'failing' ? 'text-rose-300' : 'text-amber-200'}>
            {checks.summary === 'passing'
              ? `All checks passed · ${checks.passed}/${checks.total}`
              : checks.summary === 'failing'
                ? `${checks.failed} of ${checks.total} checks failing`
                : `${checks.pending} of ${checks.total} checks running`}
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {checks.runs.slice(0, 10).map((run) => (
              <li key={run.name} className="flex items-center gap-1.5">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                    run.status !== 'completed'
                      ? 'bg-amber-300'
                      : run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped'
                        ? 'bg-emerald-400'
                        : 'bg-rose-400'
                  }`}
                  aria-hidden
                />
                <span className="truncate">{run.name}</span>
                <span className="ml-auto font-mono text-[10px] text-white/40">{run.status !== 'completed' ? run.status.replace('_', ' ') : run.conclusion}</span>
              </li>
            ))}
            {checks.total > 10 ? <li className="text-white/40">and {checks.total - 10} more</li> : null}
          </ul>
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2 text-[10px] text-white/40">
        <span className="min-w-0 flex-1">
          {live ? (
            <>
              From GitHub, checked {ageLabel(live.fetchedAt, now)}.
              {task?.github?.error ? <span className="text-rose-300/80"> The last check failed: {task.github.error}</span> : null}
            </>
          ) : task?.github?.error ? (
            <span className="text-rose-300/80">GitHub could not be asked: {task.github.error}</span>
          ) : task ? (
            "As the agent's harness last reported it. Not checked with GitHub."
          ) : (
            'As GitHub listed it.'
          )}
        </span>
        <a href={row.url} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-sky-200 hover:underline">
          View on GitHub <ExternalLink size={10} aria-hidden />
        </a>
      </div>
    </div>
  );
}

/** How long the pointer may be away from a row and its card before the card goes. */
const PULL_CARD_LINGER_MS = 150;
const PULL_CARD_WIDTH = 352;

/**
 * The hover card. It is portalled to the document's body, not drawn in the
 * list: the board's overlay has a backdrop filter, which would make it the
 * box a fixed card is placed in, and the panel under it clips. On the body,
 * the anchor's viewport coordinates are the card's. It hangs under the
 * row's number or title, or above when there is no room below, and stays
 * while the pointer is on it, so its link can be followed.
 *
 * It is the pointer's shortcut. From the keyboard, the title is a button
 * that pins the same details under the row, link and all, in tab order.
 */
function PullHoverCard({
  row,
  anchor,
  now,
  onKeep,
  onLeave,
}: {
  row: PullListRow;
  anchor: DOMRect;
  now: number;
  onKeep: () => void;
  onLeave: () => void;
}) {
  const below = window.innerHeight - anchor.bottom > 320 || anchor.top < window.innerHeight / 2;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - PULL_CARD_WIDTH - 8));
  return createPortal(
    <div
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        left,
        width: PULL_CARD_WIDTH,
        ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
        maxHeight: below ? window.innerHeight - anchor.bottom - 12 : anchor.top - 12,
      }}
      className="z-50 overflow-y-auto rounded-md border border-white/15 bg-[#161a24] p-3 shadow-xl"
    >
      <PullDetails row={row} now={now} />
    </div>,
    document.body,
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
