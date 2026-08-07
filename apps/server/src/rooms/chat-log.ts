import { AGENT_MESSAGE_BUFFER, type PlayerKind } from '@quintal/shared';

/**
 * The last few minutes of what was said in the room, held in memory only.
 *
 * Chat is ephemeral by design — nothing here reaches the database. This exists
 * so an agent that reconnects, or one that was busy thinking, can ask what it
 * missed instead of being permanently deaf to anything said half a second
 * before it looked.
 */
export interface RoomMessage {
  from: string;
  fromUserId: string;
  fromName: string;
  fromKind: PlayerKind;
  text: string;
  sentAt: number;
  /** Where the speaker stood, so distance can be judged after the fact. */
  x: number;
  y: number;
  zoneId: string | null;
}

export class ChatLog {
  readonly #messages: RoomMessage[] = [];

  constructor(private readonly capacity: number = AGENT_MESSAGE_BUFFER) {}

  push(message: RoomMessage): void {
    this.#messages.push(message);
    if (this.#messages.length > this.capacity) this.#messages.shift();
  }

  /** Newest last, which is the order a transcript is read in. */
  recent(predicate: (message: RoomMessage) => boolean, limit: number): RoomMessage[] {
    const matched: RoomMessage[] = [];
    for (let i = this.#messages.length - 1; i >= 0 && matched.length < limit; i -= 1) {
      const message = this.#messages[i];
      if (message && predicate(message)) matched.push(message);
    }
    return matched.reverse();
  }

  forget(sessionId: string): void {
    for (let i = this.#messages.length - 1; i >= 0; i -= 1) {
      if (this.#messages[i]?.from === sessionId) this.#messages.splice(i, 1);
    }
  }
}
