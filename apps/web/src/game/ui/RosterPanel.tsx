'use client';

import type { ConnectionStatus, RosterEntry } from '@quintal/shared';
import { useState } from 'react';

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

/** Glyph on every agent, everywhere. Matches the in-world nameplate. */
const AGENT_GLYPH = '◆';

function sinceLabel(at: number): string {
  if (at === 0) return 'idle';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

interface RosterPanelProps {
  players: RosterEntry[];
  connection: ConnectionStatus;
  /** Identity ids the office says are talking right now. */
  speaking?: string[];
}

/**
 * Who is in the office.
 *
 * Agents get their own section rather than being mixed into the list. That is
 * the point of the product, not a filing decision: you should be able to answer
 * "what is my fleet doing" without reading past the humans, and every agent
 * line carries whose it is.
 */
export function RosterPanel({ players, connection, speaking = [] }: RosterPanelProps) {
  const [openAgent, setOpenAgent] = useState<string | null>(null);

  const humans = players.filter((player) => player.kind === 'human');
  const agents = players.filter((player) => player.kind === 'agent');
  const selected = agents.find((agent) => agent.sessionId === openAgent) ?? null;

  return (
    <aside className="pointer-events-auto flex w-60 flex-col gap-2">
      <div className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/65 text-white backdrop-blur-sm">
        <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[connection]}`} />
          <span className="font-mono text-[11px] text-white/70">
            {STATUS_LABEL[connection]}
          </span>
          <span className="ml-auto font-mono text-[11px] text-white/45">
            {humans.length} · {agents.length}
            {AGENT_GLYPH}
          </span>
        </header>

        <ul className="max-h-40 overflow-y-auto py-1">
          {humans.length === 0 ? (
            <li className="px-3 py-1.5 text-[11px] text-white/40">Nobody here yet.</li>
          ) : (
            humans.map((player) => (
              <li
                key={player.sessionId}
                className="flex items-baseline gap-2 px-3 py-1 text-xs"
              >
                {/* A ring, not a colour change: somebody talking should be
                    findable at a glance without the name becoming unreadable. */}
                <span
                  className={`${player.isSelf ? 'text-emerald-300' : 'text-white/85'} ${
                    speaking.includes(player.identityId)
                      ? 'rounded-full bg-emerald-400/20 px-1.5 ring-1 ring-emerald-400/70'
                      : ''
                  }`}
                >
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

        <div className="border-t border-white/10 px-3 py-1.5">
          <span className="font-mono text-[10px] tracking-wide text-sky-300/80 uppercase">
            Agents
          </span>
        </div>

        <ul className="max-h-44 overflow-y-auto pb-1">
          {agents.length === 0 ? (
            <li className="px-3 py-1.5 text-[11px] text-white/40">
              None connected. See settings.
            </li>
          ) : (
            agents.map((agent) => (
              <li key={agent.sessionId}>
                <button
                  type="button"
                  onClick={() =>
                    setOpenAgent(openAgent === agent.sessionId ? null : agent.sessionId)
                  }
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-white/5 ${
                    openAgent === agent.sessionId ? 'bg-white/10' : ''
                  }`}
                >
                  <span className="flex w-full items-baseline gap-1.5 text-xs">
                    <span className="text-sky-300">
                      {AGENT_GLYPH} {agent.name}
                    </span>
                    <span className="truncate text-[10px] text-white/40">
                      {agent.ownerName ? `${agent.ownerName}'s` : ''}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-white/35">
                      {sinceLabel(agent.lastActionAt)}
                    </span>
                  </span>
                  {agent.status ? (
                    <span className="truncate font-mono text-[10px] text-white/50">
                      {agent.status}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      {selected ? <AgentCard agent={selected} onClose={() => setOpenAgent(null)} /> : null}
    </aside>
  );
}

/**
 * What an agent is, in one card: whose it is, what it's doing, what it's allowed
 * to do, and a way straight to everything it has ever done.
 */
function AgentCard({ agent, onClose }: { agent: RosterEntry; onClose: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-sky-400/25 bg-[#0b2942]/85 p-3 text-white backdrop-blur-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-sky-200">
          {AGENT_GLYPH} {agent.name}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[11px] text-white/40 hover:text-white/70"
          aria-label="Close agent card"
        >
          ✕
        </button>
      </div>

      <dl className="flex flex-col gap-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-white/40">owner</dt>
          <dd className="text-white/85">{agent.ownerName || 'unattributed'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-white/40">status</dt>
          <dd className="font-mono text-white/75">{agent.status || 'idle'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-white/40">scopes</dt>
          <dd className="font-mono text-white/75">
            {agent.scopes.length > 0 ? agent.scopes.join(' · ') : 'none'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-white/40">acted</dt>
          <dd className="text-white/75">{sinceLabel(agent.lastActionAt)}</dd>
        </div>
      </dl>

      <a
        href={`/settings/agents/${agent.identityId}/log`}
        target="_blank"
        rel="noreferrer"
        className="rounded border border-sky-400/30 px-2 py-1 text-center text-[11px] text-sky-200 hover:bg-sky-400/10"
      >
        Audit log →
      </a>
    </div>
  );
}
