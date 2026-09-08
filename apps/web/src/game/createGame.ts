import { RECONNECTION_SECONDS, type OfficeState } from '@quintal/shared';
import type { Room } from 'colyseus.js';
// Namespace import, not default: Phaser's ESM build (`module` entry, which is
// what the bundler picks) has no default export, and webpack warns on every
// build if you ask for one.
import * as Phaser from 'phaser';

import { gameBridge } from './bridge';
import { NotSignedInError, joinOffice, resumeOffice, type OfficeConnection } from './net/connection';
import { recover } from './net/recovery';
import { OfficeScene } from './scenes/OfficeScene';

const MAP_ID = 'hq';

/**
 * A running office: one Phaser game plus the room connection behind it.
 *
 * The connection is opened *before* the game so the scene can be handed a live
 * room. A canvas showing an empty office while a socket negotiates in the
 * background is worse than a moment of "connecting…" — the first thing you see
 * should be true.
 */
export interface OfficeSession {
  /** Keep the canvas in step with its container. */
  resize(width: number, height: number): void;
  /** Hand the keyboard to the chat box, or take it back. */
  setInputCaptured(captured: boolean): void;
  /** Say something in the room. */
  say(text: string): void;
  /** Post in a channel you are in. Nobody nearby hears it; every member reads it. */
  sayInChannel(channelId: string, text: string): void;
  /**
   * Ask for a page of a transcript: a channel's, a zone's, or earshot's.
   * Arrives as a `history` bridge event. `before` pages further back.
   */
  loadHistory(target: { channelId?: string; zoneId?: string; before?: number }): void;
  /** Open a direct message with a person or agent. Arrives as a `dmOpened` bridge event. */
  openDm(target: { memberId?: string; name?: string }): void;
  /** Read a zone live wherever you stand, or stop. Lines arrive as `zoneChat`. */
  followZone(zoneId: string | null): void;
  /** Join a channel by slug, or leave one by id. The office answers with `channels`. */
  joinChannel(slug: string): void;
  leaveChannel(channelId: string): void;
  destroy(): void;
}

export async function createGame(
  parent: HTMLElement,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<OfficeSession> {
  gameBridge.emit('connection', { status: 'connecting' });

  let connection: OfficeConnection;
  try {
    connection = await joinOffice(MAP_ID, signal);
  } catch (error) {
    const detail =
      error instanceof NotSignedInError
        ? error.message
        : 'Could not reach the office. Retrying will not help until the server is back.';
    gameBridge.emit('connection', { status: 'error', detail });
    throw error;
  }

  if (signal.aborted) {
    await connection.room.leave(true);
    throw new Error('aborted');
  }

  gameBridge.emit('connection', { status: 'online' });

  let room = connection.room;
  let client = connection.client;
  let closedByUs = false;

  const build = (): Phaser.Game => new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#14141c',
    // Pixel art at an integer zoom: no smoothing, no half-pixel seams.
    pixelArt: true,
    roundPixels: true,
    scale: {
      // NONE, not RESIZE: the caller owns sizing via a ResizeObserver. Phaser's
      // own parent-measuring runs before a flex child has been laid out, lands
      // on 0x0, and never recovers — a 0x0 framebuffer is a WebGL error, not a
      // blank canvas ("Framebuffer status: Incomplete Attachment").
      mode: Phaser.Scale.NONE,
      width,
      height,
    },
    // Movement is simulated by the shared stepper, on both sides of the wire.
    // An Arcade world here would be a second, disagreeing implementation.
    physics: undefined,
    // Nothing here needs the DOM, and skipping the banner keeps the console clean.
    banner: false,
    // Registered below instead of here: that's the only way to hand the scene
    // its init data on first start.
    scene: [],
  });

  let game = build();

  /**
   * Put a scene on the game for this room. Done again after every recovery:
   * the scene binds to one room at creation — its handlers, its state
   * callbacks, its idea of which player is us — and a resumed seat is a new
   * `Room` object even when it is the same seat. Rebuilding the game is the
   * honest way to rebind; the alternative is a scene that half-remembers a
   * socket that no longer exists.
   */
  const attach = (): void => {
    game.scene.add(OfficeScene.KEY, OfficeScene, true, { bridge: gameBridge, room });

    if (process.env.NODE_ENV !== 'production') {
      // Handles on the running game and room, for poking at them from the
      // console — and for cutting the socket to watch recovery happen.
      // Development only — nothing in the app reads them.
      const dev = window as unknown as { __QUINTAL_GAME__?: Phaser.Game; __QUINTAL_ROOM__?: Room<OfficeState> };
      dev.__QUINTAL_GAME__ = game;
      dev.__QUINTAL_ROOM__ = room;
    }

    room.onLeave((code) => {
      if (closedByUs) return;
      // 1000 is a clean close; anything else dropped us.
      if (code === 1000) {
        gameBridge.emit('connection', { status: 'offline', detail: 'You left the office.' });
        return;
      }
      void comeBack();
    });

    room.onError((code, message) => {
      gameBridge.emit('connection', {
        status: 'error',
        detail: message ?? `Room error ${code}`,
      });
    });
  };

  /**
   * Wait, but not past the moment something changes: a tab becoming visible
   * or a network coming back is exactly when the next attempt should happen,
   * not after whatever pause was scheduled while the lid was shut.
   */
  const waitOrWake = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', done);
        resolve();
      };
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') done();
      };
      const timer = setTimeout(done, ms);
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', done);
    });

  let recovering = false;

  /**
   * Get back in. The seat first, while the server still holds it; a fresh
   * session after that, for as long as the page is open. See `recover` for
   * the policy — this is only the wiring.
   */
  const comeBack = async (): Promise<void> => {
    if (recovering) return;
    recovering = true;
    const token = room.reconnectionToken;

    gameBridge.emit('connection', {
      status: 'reconnecting',
      detail: `Connection lost — reconnecting (your seat is kept for ${RECONNECTION_SECONDS}s)…`,
    });

    const outcome = await recover<OfficeConnection>(
      {
        resume: async () => ({ room: await resumeOffice(client, token), client }),
        join: () => joinOffice(MAP_ID),
        wait: waitOrWake,
        now: () => Date.now(),
        cancelled: () => closedByUs,
        report: (phase, attempt) => {
          if (phase === 'rejoining') {
            gameBridge.emit('connection', {
              status: 'reconnecting',
              detail:
                attempt === 1
                  ? 'Your seat was given up — rejoining the office…'
                  : `Rejoining the office (attempt ${attempt})…`,
            });
          }
        },
      },
      { resumeWindowMs: RECONNECTION_SECONDS * 1000 },
    );
    recovering = false;

    switch (outcome.kind) {
      case 'cancelled':
        return;
      case 'refused':
        gameBridge.emit('connection', {
          status: 'error',
          detail:
            outcome.error instanceof Error ? outcome.error.message : 'Could not rejoin the office.',
        });
        return;
      case 'resumed':
      case 'rejoined': {
        room = outcome.room.room;
        client = outcome.room.client;
        // The old game is bound to the old socket. Replace it whole; the UI
        // above the canvas keeps what it has — transcripts merge by id.
        game.destroy(true);
        game = build();
        attach();
        gameBridge.emit('connection', { status: 'online' });
        return;
      }
    }
  };

  attach();

  const scene = (): OfficeScene | undefined =>
    game.scene.getScene(OfficeScene.KEY) as OfficeScene | undefined;

  return {
    resize(width_, height_) {
      game.scale.resize(width_, height_);
    },
    setInputCaptured(captured) {
      scene()?.setInputCaptured(captured);
    },
    say(text) {
      scene()?.say(text);
    },
    sayInChannel(channelId, text) {
      scene()?.sayInChannel(channelId, text);
    },
    loadHistory(target) {
      scene()?.loadHistory(target);
    },
    openDm(target) {
      scene()?.openDm(target);
    },
    followZone(zoneId) {
      scene()?.followZone(zoneId);
    },
    joinChannel(slug) {
      scene()?.joinChannel(slug);
    },
    leaveChannel(channelId) {
      scene()?.leaveChannel(channelId);
    },
    destroy() {
      closedByUs = true;
      void room.leave(true);
      game.destroy(true);
    },
  };
}
