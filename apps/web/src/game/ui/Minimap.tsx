'use client';

import type { ConnectionStatus, GameEvents, OfficeMap } from '@quintal/shared';
import { useEffect, useMemo, useState } from 'react';

import { gameBridge } from '../bridge';
import { minimapBounds, minimapObstacles } from './minimapGeometry';

const ZONE_COLORS = {
  private: '#334155',
  common: '#29443d',
  spawn: '#37554b',
  agent_area: '#30475f',
};

export function Minimap({ connection }: { connection: ConnectionStatus }) {
  const [map, setMap] = useState<OfficeMap | null>(null);
  const [snapshot, setSnapshot] = useState<GameEvents['minimap'] | null>(null);
  const [nearby, setNearby] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const offMap = gameBridge.on('minimapMap', (value) => {
      setMap(value);
      setSnapshot(null);
    });
    const offPositions = gameBridge.on('minimap', setSnapshot);
    return () => { offMap(); offPositions(); };
  }, []);

  const obstacles = useMemo(() => map ? minimapObstacles(map) : '', [map]);
  if (!map || !snapshot || connection !== 'online') return null;

  const self = snapshot.players.find((player) => player.isSelf);
  const bounds = nearby
    ? minimapBounds(map, snapshot.viewport, self)
    : { x: 0, y: 0, width: map.width, height: map.height };
  const radius = bounds.width / 100;
  const view = snapshot.viewport;
  const visibleX = Math.max(0, view.x);
  const visibleY = Math.max(0, view.y);
  const visibleWidth = Math.max(0, Math.min(map.width, view.x + view.width) - visibleX);
  const visibleHeight = Math.max(0, Math.min(map.height, view.y + view.height) - visibleY);

  return (
    <aside
      aria-label="Office minimap"
      className="absolute bottom-20 right-3 max-w-[40%] overflow-hidden rounded-lg border border-white/20 bg-[#14141c]/95 text-white shadow-lg"
      style={{ width: collapsed ? 'auto' : 'clamp(140px, 24vw, 240px)' }}
      data-testid="office-minimap"
    >
      <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-[11px]">
        <span className="font-medium">Office map</span>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Show minimap' : 'Hide minimap'}
          aria-expanded={!collapsed}
          className="rounded px-1.5 text-white/70 hover:bg-white/10 focus-visible:outline focus-visible:outline-white"
        >
          {collapsed ? '+' : '−'}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="flex gap-1 px-2.5 pb-2">
            {[false, true].map((local) => (
              <button
                key={String(local)}
                type="button"
                aria-pressed={nearby === local}
                onClick={() => setNearby(local)}
                className={`flex-1 rounded px-2 py-1 text-[10px] focus-visible:outline focus-visible:outline-white ${nearby === local ? 'bg-white/15 text-white' : 'text-white/50 hover:bg-white/10'}`}
              >
                {local ? 'Nearby' : 'Whole office'}
              </button>
            ))}
          </div>
          <svg
            role="img"
            aria-label={`${nearby ? 'Nearby area' : map.name}. ${snapshot.players.filter((p) => !p.isSelf && p.kind === 'human').length} other users and ${snapshot.players.filter((p) => p.kind === 'agent').length} agents in the office. Outlined rectangle shows your current view.`}
            viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
            className="block w-full overflow-hidden bg-[#20252d]"
          >
            <title>Office layout and live occupant positions</title>
            {map.zones.map((zone) => (
              <rect key={zone.id} {...zone.bounds} fill={ZONE_COLORS[zone.kind]}>
                <title>{zone.label}</title>
              </rect>
            ))}
            <path d={obstacles} fill="#11151d" />
            <rect
              x={visibleX} y={visibleY} width={visibleWidth} height={visibleHeight}
              fill="#ffffff" fillOpacity={0.06} stroke="#ffffff" strokeOpacity={0.65}
              strokeWidth={radius / 2}
            />
            {snapshot.players.map((player) => (
              <g key={player.sessionId} transform={`translate(${player.x} ${player.y})`}>
                <title>{player.isSelf ? `${player.name} (you)` : `${player.name} (${player.kind === 'agent' ? 'agent' : 'user'})`}</title>
                {player.isSelf ? (
                  <circle r={radius * 1.8} fill="none" stroke="#34d399" strokeWidth={radius / 2} />
                ) : null}
                {player.kind === 'agent' ? (
                  <path d={`M0 ${-radius * 1.4}L${radius * 1.4} 0L0 ${radius * 1.4}L${-radius * 1.4} 0Z`} fill="#60a5fa" stroke="#14141c" strokeWidth={radius / 3} />
                ) : (
                  <circle r={radius} fill={player.isSelf ? '#34d399' : '#fbbf24'} stroke="#14141c" strokeWidth={radius / 3} />
                )}
              </g>
            ))}
          </svg>
          <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 px-2.5 py-2 text-[10px] text-white/70">
            <span><span className="text-emerald-400">●</span> You</span>
            <span><span className="text-amber-400">●</span> Users</span>
            <span><span className="text-blue-400">◆</span> Agents</span>
          </div>
        </>
      )}
    </aside>
  );
}
