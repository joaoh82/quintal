import { TILE_SIZE } from '@quintal/shared';
// Namespace import, not default: Phaser's ESM build (`module` entry, which is
// what the bundler picks) has no default export, and webpack warns on every
// build if you ask for one.
import * as Phaser from 'phaser';

import { gameBridge } from './bridge';
import { OfficeScene } from './scenes/OfficeScene';

/**
 * Build the Phaser game. Called exactly once per mount — see OfficeGame.tsx for
 * the StrictMode dance.
 */
export function createGame(parent: HTMLElement, width: number, height: number): Phaser.Game {
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
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { x: 0, y: 0 },
        tileBias: TILE_SIZE,
        debug: false,
      },
    },
    // Nothing here needs the DOM, and skipping the banner keeps the console clean.
    banner: false,
    // Registered below instead of here: that's the only way to hand the scene
    // its init data (the bridge) on first start.
    scene: [],
  });

  game.scene.add(OfficeScene.KEY, OfficeScene, true, { bridge: gameBridge });

  if (process.env.NODE_ENV !== 'production') {
    // A handle on the running game, for poking at the scene from the console.
    // Development only — nothing in the app reads it.
    (window as unknown as { __QUINTAL_GAME__?: Phaser.Game }).__QUINTAL_GAME__ = game;
  }

  return game;
}
