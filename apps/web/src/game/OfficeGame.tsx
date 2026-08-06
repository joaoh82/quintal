'use client';

import type { MapZone } from '@quintal/shared';
import type Phaser from 'phaser';
import { useEffect, useRef, useState } from 'react';

import { gameBridge } from './bridge';

interface Hud {
  mapName: string;
  tile: { x: number; y: number };
  zone: MapZone | null;
  debug: boolean;
  pathLength: number;
}

const INITIAL_HUD: Hud = {
  mapName: '',
  tile: { x: 0, y: 0 },
  zone: null,
  debug: false,
  pathLength: 0,
};

/**
 * Hosts the Phaser canvas.
 *
 * The game is created once and torn down on unmount. React StrictMode mounts
 * every effect twice in development, so without the ref guard you get two
 * games fighting over one container — two canvases, doubled input, halved
 * frame rate. The guard plus a real `destroy()` in cleanup keeps exactly one
 * game alive in both dev and production.
 *
 * No game state lives in React. The HUD below subscribes to the bridge, which
 * only fires when something a human would notice actually changes.
 */
export default function OfficeGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [hud, setHud] = useState<Hud>(INITIAL_HUD);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    // Boot on the first non-zero measurement rather than on mount: a flex child
    // has no size yet when the effect runs, and Phaser cannot recover from
    // being started at 0x0. The same observer keeps the canvas in step with the
    // window afterwards.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;

      const game = gameRef.current;
      if (game) {
        game.scale.resize(box.width, box.height);
        return;
      }

      // Phaser touches `window` at import time, so it can't be a static import
      // in a file Next might evaluate on the server.
      void import('./createGame').then(({ createGame }) => {
        if (cancelled || gameRef.current) return;
        gameRef.current = createGame(container, box.width, box.height);
      });
    });

    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = [
      gameBridge.on('ready', ({ mapName }) => setHud((prev) => ({ ...prev, mapName }))),
      gameBridge.on('tile', ({ x, y }) => setHud((prev) => ({ ...prev, tile: { x, y } }))),
      gameBridge.on('zone', ({ zone }) => setHud((prev) => ({ ...prev, zone }))),
      gameBridge.on('debug', ({ enabled }) => setHud((prev) => ({ ...prev, debug: enabled }))),
      gameBridge.on('path', ({ length }) => setHud((prev) => ({ ...prev, pathLength: length }))),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, []);

  return (
    <div className="relative isolate h-full w-full overflow-hidden rounded-xl border bg-[#14141c]">
      <div ref={containerRef} className="h-full w-full" data-testid="phaser-container" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-4 gap-y-1 bg-black/55 px-3 py-2 font-mono text-[11px] text-white/80 backdrop-blur-sm">
        <span className="text-white">{hud.mapName || 'loading…'}</span>
        <span>
          {hud.tile.x},{hud.tile.y}
        </span>
        <span className={hud.zone ? 'text-emerald-300' : 'text-white/40'}>
          {hud.zone ? `${hud.zone.label} · ${hud.zone.kind}` : 'open floor'}
        </span>
        {hud.pathLength > 0 ? <span className="text-sky-300">walking · {hud.pathLength}</span> : null}
        <span className="ml-auto text-white/45">
          WASD / arrows · click to walk · Z {hud.debug ? 'hides' : 'shows'} zones
        </span>
      </div>
    </div>
  );
}
