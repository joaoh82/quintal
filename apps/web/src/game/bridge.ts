import { createGameBridge, type GameBridge } from '@quintal/shared';

/**
 * The single bridge instance for this tab. Phaser emits on it, React listens.
 * A module singleton rather than context: the scene is created outside the
 * React tree and needs a stable handle that doesn't depend on render order.
 */
export const gameBridge: GameBridge = createGameBridge();
