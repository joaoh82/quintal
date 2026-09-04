'use client';

import { type ConnectionStatus, type MapZone, type RosterEntry } from '@quintal/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getOverlayKey } from '@/lib/preferences';

import { gameBridge } from './bridge';
import type { OfficeSession } from './createGame';
import { ChatPanel } from './ui/ChatPanel';
import { CommsOverlay } from './ui/CommsOverlay';
import { HelpPanel } from './ui/HelpPanel';
import { RosterPanel } from './ui/RosterPanel';
import { useConversations } from './useConversations';

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
 * Hosts the Phaser canvas and the overlays around it.
 *
 * The game is created once and torn down on unmount. React StrictMode mounts
 * every effect twice in development, so without the guard you get two games —
 * and, now, two room connections — fighting over one container.
 *
 * No game state lives in React. The overlays subscribe to the bridge, which
 * only fires when something a human would notice actually changes: a roster
 * update, a message, a tile crossing. Positions never come through here.
 */
export default function OfficeGame() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<OfficeSession | null>(null);
  /** True from the moment we start building a session until it exists. */
  const startingRef = useRef(false);

  const [hud, setHud] = useState<Hud>(INITIAL_HUD);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [connectionDetail, setConnectionDetail] = useState<string>('');
  const [chatFocused, setChatFocused] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayKey, setOverlayKey] = useState('`');

  const conversations = useConversations(sessionRef);

  // The key is a device preference; read it once the page has a window.
  useEffect(() => setOverlayKey(getOverlayKey()), []);

  // `?` opens help; the overlay key opens the conversations panel. The chat
  // input stops keydown propagation, so typing either in a sentence never
  // reaches this.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '?') setHelpOpen((open) => !open);
      else if (event.key === overlayKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setOverlayOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlayKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = new AbortController();
    let disposed = false;

    // Boot on the first non-zero measurement rather than on mount: a flex child
    // has no size yet when the effect runs, and Phaser cannot recover from
    // being started at 0x0. The same observer keeps the canvas in step with the
    // window afterwards.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;

      if (sessionRef.current) {
        sessionRef.current.resize(box.width, box.height);
        return;
      }
      // Claim the slot synchronously: the import below is async and the
      // observer can fire again before it resolves.
      if (startingRef.current) return;
      startingRef.current = true;

      // Phaser touches `window` at import time, so it can't be a static import
      // in a file Next might evaluate on the server.
      void import('./createGame')
        .then(({ createGame }) =>
          createGame(container, box.width, box.height, controller.signal),
        )
        .then((session) => {
          if (disposed) {
            session.destroy();
            return;
          }
          sessionRef.current = session;
        })
        .catch(() => {
          // createGame already reported the reason over the bridge.
          startingRef.current = false;
        });
    });

    observer.observe(container);

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      sessionRef.current?.destroy();
      sessionRef.current = null;
      startingRef.current = false;
      // The bridge is a module singleton and outlives the game.
      gameBridge.clear();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = [
      gameBridge.on('ready', ({ mapName }) => setHud((prev) => ({ ...prev, mapName }))),
      gameBridge.on('tile', ({ x, y }) => setHud((prev) => ({ ...prev, tile: { x, y } }))),
      gameBridge.on('zone', ({ zone }) => setHud((prev) => ({ ...prev, zone }))),
      gameBridge.on('debug', ({ enabled }) => setHud((prev) => ({ ...prev, debug: enabled }))),
      gameBridge.on('path', ({ length }) => setHud((prev) => ({ ...prev, pathLength: length }))),
      gameBridge.on('roster', ({ players }) => setRoster(players)),
      // A DM you opened from a card is a conversation you meant to type in.
      gameBridge.on('dmOpened', () => setChatFocused(true)),
      gameBridge.on('connection', ({ status, detail }) => {
        setConnection(status);
        setConnectionDetail(detail ?? '');
      }),
    ];
    return () => {
      for (const off of unsubscribe) off();
    };
  }, []);

  /**
   * Enter opens the chat box from anywhere on the page; Escape hands the
   * keyboard back. Bound on the window so it works whether the last click
   * landed on the canvas or on a panel — the canvas is not a focusable element,
   * so relying on focus alone would break the moment you clicked a roster row.
   * The overlay has its own input and its own Escape; while it is open this
   * stays out of the way.
   */
  useEffect(() => {
    if (overlayOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !chatFocused) {
        event.preventDefault();
        setChatFocused(true);
      } else if (event.key === 'Escape' && chatFocused) {
        event.preventDefault();
        setChatFocused(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chatFocused, overlayOpen]);

  // One place decides whether the office or a text box owns the keyboard.
  useEffect(() => {
    sessionRef.current?.setInputCaptured(chatFocused || overlayOpen);
  }, [chatFocused, overlayOpen]);

  const openDm = useCallback(
    (entry: RosterEntry) => conversations.openDm({ memberId: entry.identityId }),
    [conversations],
  );

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const reconnecting = connection === 'reconnecting' || connection === 'connecting';

  return (
    <div className="relative isolate h-full w-full overflow-hidden rounded-xl border bg-[#14141c]">
      <div ref={containerRef} className="h-full w-full" data-testid="phaser-container" />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-end gap-3 p-3">
        <RosterPanel players={roster} connection={connection} onMessage={openDm} />
      </div>

      <div className="pointer-events-none absolute bottom-10 left-3">
        <ChatPanel
          conversations={conversations}
          focused={chatFocused}
          roster={roster}
          onFocusChange={setChatFocused}
          overlayKey={overlayKey}
          onOpenOverlay={() => setOverlayOpen(true)}
        />
      </div>

      {(reconnecting && connectionDetail) || connection === 'error' || connection === 'offline' ? (
        <div
          role="status"
          className={`pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-md px-3 py-2 text-xs shadow-lg ${
            connection === 'error'
              ? 'bg-rose-600 text-white'
              : 'bg-amber-500 text-black'
          }`}
        >
          {connectionDetail || 'Reconnecting…'}
        </div>
      ) : null}

      {conversations.notice && !overlayOpen ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 rounded-md bg-white/90 px-3 py-1.5 text-xs text-black shadow"
        >
          {conversations.notice}
        </div>
      ) : null}

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
          {chatFocused
            ? 'Esc returns to walking'
            : `WASD / arrows · click to walk · Enter to chat · ${overlayKey} for all conversations · Z ${hud.debug ? 'hides' : 'shows'} zones`}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          aria-label="Keys and commands"
          className="pointer-events-auto rounded border border-white/20 px-1.5 leading-5 text-white/70 hover:bg-white/10 hover:text-white"
        >
          ?
        </button>
      </div>

      {overlayOpen ? (
        <CommsOverlay
          conversations={conversations}
          roster={roster}
          toggleKey={overlayKey}
          onClose={closeOverlay}
          onLeaveChannel={(channelId) => {
            sessionRef.current?.leaveChannel(channelId);
            conversations.select('nearby');
          }}
        />
      ) : null}

      {helpOpen ? (
        <HelpPanel onClose={() => setHelpOpen(false)} overlayKey={overlayKey} />
      ) : null}
    </div>
  );
}
