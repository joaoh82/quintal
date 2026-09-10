import { isAddressed, type ChannelRef } from '@quintal/shared';

import { channelKey, type ConversationKey } from './conversationKey';

/**
 * What is waiting for you in conversations you are not looking at.
 *
 * Buzz gets this right and it is most of what makes a sidebar feel alive:
 * fire off a question in a channel, go do something else, and the row tells
 * you when there is an answer. Two numbers per conversation — how many lines
 * since you last looked, and whether any of them was for you — and one time
 * per conversation, when you last looked, so a reload does not bring every
 * channel back as unread.
 *
 * Pure. The store owns the clock and the storage; this owns the rules, so
 * the rules can be tested for what they must never do — count your own
 * words, or count a line said in the conversation you are reading.
 */

export interface Unread {
  /**
   * Lines since you last looked. 0 with an entry present means "something,
   * said while you were away": the row shows a dot rather than a number.
   */
  count: number;
  /** One of them named you, or the conversation is a DM. */
  mentioned: boolean;
}

export interface ReadState {
  /** conversation key -> when you last looked, ms since epoch. */
  lastReadAt: Record<ConversationKey, number>;
  unread: Record<ConversationKey, Unread>;
}

export const EMPTY_READ_STATE: ReadState = { lastReadAt: {}, unread: {} };

export interface Listener {
  /** My session, to leave my own words out. Null before the roster arrives. */
  selfSessionId: string | null;
  /** My name, to know when a line is for me. */
  myName: string;
  /** Conversations in view right now: a line landing in one is read on arrival. */
  visible: readonly ConversationKey[];
  /** Whether `key` is a DM, where every line is for me. */
  isDm: boolean;
}

/** A line has landed in a conversation. */
export function heard(
  state: ReadState,
  key: ConversationKey,
  line: { from: string; text: string; sentAt: number },
  listener: Listener,
  now: number,
): ReadState {
  const mine = listener.selfSessionId !== null && line.from === listener.selfSessionId;
  if (mine || listener.visible.includes(key)) {
    // Read as it lands — and noted as such, so it is not news after a reload.
    return read(state, key, Math.max(now, line.sentAt));
  }
  const current = state.unread[key] ?? { count: 0, mentioned: false };
  return {
    ...state,
    unread: {
      ...state.unread,
      [key]: {
        count: current.count + 1,
        mentioned: current.mentioned || listener.isDm || isAddressed(line.text, listener.myName),
      },
    },
  };
}

/** You are looking at it: nothing is waiting there any more. */
export function read(state: ReadState, key: ConversationKey, now: number): ReadState {
  const { [key]: _gone, ...rest } = state.unread;
  const lastReadAt = Math.max(state.lastReadAt[key] ?? 0, now);
  if (_gone === undefined && lastReadAt === state.lastReadAt[key]) return state;
  return { lastReadAt: { ...state.lastReadAt, [key]: lastReadAt }, unread: rest };
}

/**
 * The channel list has arrived, with when each last heard something. A
 * channel that spoke after you last looked — or that you never looked at —
 * has something waiting; how much, the list does not say, so it is a dot.
 * Never overrides a count already being kept, and never marks what is in view.
 */
export function caughtUp(
  state: ReadState,
  channels: readonly ChannelRef[],
  visible: readonly ConversationKey[],
): ReadState {
  let next = state;
  for (const channel of channels) {
    const key = channelKey(channel.id);
    const at = channel.lastMessageAt ?? 0;
    if (at === 0 || visible.includes(key) || next.unread[key] !== undefined) continue;
    if (at <= (next.lastReadAt[key] ?? 0)) continue;
    next = {
      ...next,
      unread: { ...next.unread, [key]: { count: 0, mentioned: channel.kind === 'dm' } },
    };
  }
  return next;
}

// --- persistence -----------------------------------------------------------

export const LAST_READ_STORAGE_KEY = 'quintal:lastRead';
/** Conversations remembered. Plenty for an office; bounded so it never grows forever. */
const LAST_READ_KEEP = 200;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** When you last looked at each conversation, from a previous visit. */
export function loadLastRead(storage: Storage | undefined): Record<ConversationKey, number> {
  try {
    const raw = storage?.getItem(LAST_READ_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<ConversationKey, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember when you last looked, keeping the most recent conversations. */
export function saveLastRead(
  storage: Storage | undefined,
  lastReadAt: Record<ConversationKey, number>,
): void {
  try {
    const kept = Object.entries(lastReadAt)
      .sort(([, a], [, b]) => b - a)
      .slice(0, LAST_READ_KEEP);
    storage?.setItem(LAST_READ_STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // A browser with storage off still gets a working sidebar; it just forgets.
  }
}
