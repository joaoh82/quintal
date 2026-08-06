import { Room, type Client, logger } from '@colyseus/core';

/**
 * Placeholder for the one room type Quintal has: an office.
 *
 * There is deliberately no state schema, no movement and no tile map here yet —
 * this exists so the transport, matchmaking and the single-process production
 * setup can be exercised end to end before any game code lands.
 */
export class OfficeRoom extends Room {
  override maxClients = 64;

  override onCreate(options: unknown): void {
    logger.info(`[office] room ${this.roomId} created`, options);
  }

  override onJoin(client: Client): void {
    logger.info(`[office] ${client.sessionId} joined ${this.roomId}`);
  }

  override onLeave(client: Client, consented?: boolean): void {
    logger.info(
      `[office] ${client.sessionId} left ${this.roomId} (consented: ${consented === true})`,
    );
  }

  override onDispose(): void {
    logger.info(`[office] room ${this.roomId} disposed`);
  }
}
