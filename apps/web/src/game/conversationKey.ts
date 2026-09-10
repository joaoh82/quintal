/**
 * How a conversation is named on this client.
 *
 * Keys are strings so a Record can hold them: `nearby`, `zone:<id>`,
 * `channel:<id>` (DMs are channels here; the distinction is the ref's kind).
 * Kept apart from the store so the pure modules that reason about keys —
 * presence, unread — need neither React nor the game to be tested.
 */
export type ConversationKey = string;

export const NEARBY: ConversationKey = 'nearby';
export const zoneKey = (zoneId: string): ConversationKey => `zone:${zoneId}`;
export const channelKey = (channelId: string): ConversationKey => `channel:${channelId}`;

export function parseKey(key: ConversationKey): { zoneId?: string; channelId?: string } {
  if (key.startsWith('zone:')) return { zoneId: key.slice(5) };
  if (key.startsWith('channel:')) return { channelId: key.slice(8) };
  return {};
}
