'use client';

import type { ConnectionStatus, RosterEntry } from '@quintal/shared';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'connecting',
  online: 'online',
  reconnecting: 'reconnecting',
  offline: 'offline',
  error: 'error',
};

const STATUS_DOT: Record<ConnectionStatus, string> = {
  connecting: 'bg-amber-400 animate-pulse',
  online: 'bg-emerald-400',
  reconnecting: 'bg-amber-400 animate-pulse',
  offline: 'bg-white/30',
  error: 'bg-rose-500',
};

interface RosterPanelProps {
  players: RosterEntry[];
  connection: ConnectionStatus;
}

/**
 * Who is in the office. Reads `kind` rather than assuming humans — when agents
 * arrive they appear here through the same room state, marked but not
 * segregated: they're colleagues, not a separate list.
 */
export function RosterPanel({ players, connection }: RosterPanelProps) {
  const humans = players.filter((player) => player.kind === 'human').length;
  const agents = players.length - humans;

  return (
    <aside className="pointer-events-auto flex w-52 flex-col overflow-hidden rounded-lg border border-white/10 bg-black/65 text-white backdrop-blur-sm">
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[connection]}`} />
        <span className="font-mono text-[11px] text-white/70">
          {STATUS_LABEL[connection]}
        </span>
        <span className="ml-auto font-mono text-[11px] text-white/45">
          {humans}
          {agents > 0 ? ` +${agents}◆` : ''}
        </span>
      </header>

      <ul className="max-h-56 overflow-y-auto py-1">
        {players.length === 0 ? (
          <li className="px-3 py-2 text-[11px] text-white/40">Nobody here yet.</li>
        ) : (
          players.map((player) => (
            <li
              key={player.sessionId}
              className="flex items-baseline gap-2 px-3 py-1 text-xs"
            >
              <span
                className={
                  player.kind === 'agent'
                    ? 'text-sky-300'
                    : player.isSelf
                      ? 'text-emerald-300'
                      : 'text-white/85'
                }
              >
                {player.kind === 'agent' ? '◆ ' : ''}
                {player.name}
              </span>
              {player.isSelf ? (
                <span className="font-mono text-[10px] text-white/35">you</span>
              ) : null}
              {player.status ? (
                <span className="ml-auto truncate font-mono text-[10px] text-white/45">
                  {player.status}
                </span>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </aside>
  );
}
