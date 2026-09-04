/**
 * Where a thing is said.
 *
 * One model for three shapes of conversation. A `zone` is a room on the map —
 * whoever stands in it is in the conversation, nobody is a member. A `channel`
 * names its members. A `dm` is a channel nobody can find: members fixed at
 * creation, never listed. Only zones exist yet; the other two are the same
 * table with a members list.
 */
export const CONVERSATION_KINDS = ['zone', 'channel', 'dm'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * The zone a tile outside every zone belongs to.
 *
 * Most of an office is corridor and open floor, and a conversation held there
 * is still a conversation: an agent asked to "come here" is usually asked from
 * the middle of the room, not from inside one. Rather than leave those words
 * with nowhere to go, every map has one implicit zone for everything that is
 * not otherwise a zone.
 */
export const FLOOR_ZONE_ID = 'floor';
export const FLOOR_ZONE_LABEL = 'the open floor';
