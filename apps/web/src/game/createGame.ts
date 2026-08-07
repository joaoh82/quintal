import { RECONNECTION_SECONDS, type OfficeState } from '@quintal/shared';
import type { Room } from 'colyseus.js';
// Namespace import, not default: Phaser's ESM build (`module` entry, which is
// what the bundler picks) has no default export, and webpack warns on every
// build if you ask for one.
import * as Phaser from 'phaser';

import { gameBridge } from './bridge';
import { NotSignedInError, joinOffice } from './net/connection';
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
  destroy(): void;
}

export async function createGame(
  parent: HTMLElement,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<OfficeSession> {
  gameBridge.emit('connection', { status: 'connecting' });

  let room: Room<OfficeState>;
  try {
    room = await joinOffice(MAP_ID, signal);
  } catch (error) {
    const detail =
      error instanceof NotSignedInError
        ? error.message
        : 'Could not reach the office. Retrying will not help until the server is back.';
    gameBridge.emit('connection', { status: 'error', detail });
    throw error;
  }

  if (signal.aborted) {
    await room.leave(true);
    throw new Error('aborted');
  }

  gameBridge.emit('connection', { status: 'online' });

  const game = new Phaser.Game({
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

  game.scene.add(OfficeScene.KEY, OfficeScene, true, { bridge: gameBridge, room });

  if (process.env.NODE_ENV !== 'production') {
    // A handle on the running game, for poking at the scene from the console.
    // Development only — nothing in the app reads it.
    (window as unknown as { __QUINTAL_GAME__?: Phaser.Game }).__QUINTAL_GAME__ = game;
  }

  let closedByUs = false;

  room.onLeave((code) => {
    if (closedByUs) return;
    // 1000 is a clean close; anything else dropped us. The server holds the
    // avatar in place for RECONNECTION_SECONDS, so say so rather than
    // pretending the connection is fine.
    gameBridge.emit('connection', {
      status: code === 1000 ? 'offline' : 'reconnecting',
      detail:
        code === 1000
          ? 'You left the office.'
          : `Connection lost — your avatar stays put for ${RECONNECTION_SECONDS}s.`,
    });
  });

  room.onError((code, message) => {
    gameBridge.emit('connection', {
      status: 'error',
      detail: message ?? `Room error ${code}`,
    });
  });

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
    destroy() {
      closedByUs = true;
      void room.leave(true);
      game.destroy(true);
    },
  };
}
