import {
  isAddressed,
  type ChatBroadcastPayload,
  type PublicActivity,
  type PublicApprovalRequest,
} from '@quintal/shared';

import { approvalKey, waitingApprovals, type ApprovalState } from './approvals';
import { NEARBY, type ConversationKey } from './conversationKey';
import type { Unread } from './unread';

/**
 * When an agent needs you and you are not looking.
 *
 * Everything the office already shows about an agent waiting — the card, the
 * pill, the unread dot — is inside the window. That is no help to somebody in
 * their editor, and none at all once the app can run with its window closed.
 * This is the rule for what is worth interrupting them for; how they are told
 * (a system notification, a sound) is `lib/alert-delivery.ts`.
 *
 * Pure, like `unread.ts`, and for the same reason: what it must never do —
 * alert about your own words, about somebody else's agent's question, about
 * the conversation you are reading, or about the same thing twice — is worth
 * pinning without a browser.
 *
 * Three things qualify, and all three are an agent's doing. People are not
 * in here: a wave or a knock is a different feature with different manners.
 */

export type AlertKind = 'approval' | 'reply' | 'done';

export interface Alert {
  kind: AlertKind;
  /** Stable per occurrence, so the same one is never raised twice. */
  id: string;
  title: string;
  body: string;
  /** Where to go to deal with it. Null for a card shown in your own corner. */
  key: ConversationKey | null;
}

/** What the person can see right now. */
export interface Looking {
  /** The window has the keyboard. A hidden or covered window does not. */
  focused: boolean;
  /** Conversations in view — see `useConversations`. */
  visible: readonly ConversationKey[];
}

/**
 * Is this already in front of them?
 *
 * `keys` is every transcript the thing appears in; an empty list means it is
 * drawn outside any transcript (a private card, in the corner), which is in
 * view whenever the window is.
 */
export function inFrontOfThem(looking: Looking, keys: readonly ConversationKey[]): boolean {
  if (!looking.focused) return false;
  return keys.length === 0 || keys.some((key) => looking.visible.includes(key));
}

/** One of your agents is asking permission. */
export function approvalAlert(
  approval: PublicApprovalRequest,
  myUserId: string,
  looking: Looking,
): Alert | null {
  // Only the owner can answer, so only the owner is interrupted.
  if (myUserId === '' || approval.ownerUserId !== myUserId) return null;
  const key = approval.private ? null : approvalKey(approval);
  // A spatial card is also drawn in the nearby box.
  const keys = key === null ? [] : approval.zoneId ? [key, NEARBY] : [key];
  if (inFrontOfThem(looking, keys)) return null;
  return {
    kind: 'approval',
    id: `approval:${approval.requestId}`,
    title: `${approval.agentName} needs your permission`,
    body: approval.summary ? `${approval.toolName}: ${approval.summary}` : approval.toolName,
    key,
  };
}

export interface LineContext {
  /** My session, to leave my own words out. */
  selfSessionId: string | null;
  myName: string;
  /** The conversation is a DM, where every line is for me. */
  isDm: boolean;
}

/** An agent said something to you: by name, or in a direct message. */
export function lineAlert(
  key: ConversationKey,
  line: ChatBroadcastPayload,
  context: LineContext,
  looking: Looking,
): Alert | null {
  if (line.fromKind !== 'agent' || line.text.trim() === '') return null;
  if (context.selfSessionId !== null && line.from === context.selfSessionId) return null;
  if (!context.isDm && !isAddressed(line.text, context.myName)) return null;
  if (inFrontOfThem(looking, [key])) return null;
  return {
    kind: 'reply',
    id: `line:${line.sentAt}:${line.fromName}:${line.text}`,
    title: line.fromName,
    body: line.text,
    key,
  };
}

/**
 * One of your agents finished a turn, or failed one.
 *
 * Cancelled, interrupted and disconnected are left out: the first you did
 * yourself, and the other two are the connection's news, which the office
 * already reports its own way.
 */
export function doneAlert(
  activity: PublicActivity,
  mine: boolean,
  key: ConversationKey | null,
  looking: Looking,
): Alert | null {
  if (!mine) return null;
  if (activity.state !== 'completed' && activity.state !== 'failed') return null;
  const keys = key === null ? [] : activity.nearby ? [key, NEARBY] : [key];
  if (key !== null && inFrontOfThem(looking, keys)) return null;
  // No transcript we can name: say it only when the window is not there at all.
  if (key === null && looking.focused) return null;
  return {
    kind: 'done',
    id: `turn:${activity.agentId}:${activity.turnId}`,
    title:
      activity.state === 'failed'
        ? `${activity.agentName} could not finish`
        : `${activity.agentName} is done`,
    body:
      activity.state === 'failed'
        ? 'The turn failed. Open the office to see what happened.'
        : 'The turn finished. Open the office to read the result.',
    key,
  };
}

/** Alerts already raised, kept so each is raised once. Bounded. */
const REMEMBER = 200;
/** Two alerts from one agent closer than this are one interruption. */
export const QUIET_MS = 8_000;

export interface AlertLog {
  seen: string[];
  /** Who last interrupted, and when, by title's agent name. */
  last: Record<string, number>;
}

export const EMPTY_ALERT_LOG: AlertLog = { seen: [], last: {} };

/**
 * Should this one actually interrupt, given what already has?
 *
 * Never twice for the same occurrence: a card the office re-sends after its
 * agent reconnects is the same question. And not twice in a breath from the
 * same agent — a reply and the end of the turn that produced it arrive
 * together, and are one thing to the person hearing them. A permission
 * request is exempt from that second rule: it has a deadline, and it is not
 * to be swallowed by the chime of a line that came just before it.
 */
export function admit(
  log: AlertLog,
  alert: Alert,
  agent: string,
  now: number,
): { log: AlertLog; raise: boolean } {
  if (log.seen.includes(alert.id)) return { log, raise: false };
  const seen = [...log.seen, alert.id].slice(-REMEMBER);
  const recent = log.last[agent];
  if (alert.kind !== 'approval' && recent !== undefined && now - recent < QUIET_MS) {
    return { log: { ...log, seen }, raise: false };
  }
  return { log: { seen, last: { ...log.last, [agent]: now } }, raise: true };
}

/**
 * How many of my agents are waiting on me right now — the tray's number —
 * and when the soonest of them stops waiting, so the host can count down
 * without us.
 */
export function waitingOnMe(
  state: ApprovalState,
  myUserId: string,
  now = Date.now(),
): { waiting: number; until: number | null } {
  if (myUserId === '') return { waiting: 0, until: null };
  const mine = waitingApprovals(state, now).filter((approval) => approval.ownerUserId === myUserId);
  return {
    waiting: mine.length,
    until: mine.length === 0 ? null : Math.min(...mine.map((approval) => approval.expiresAt)),
  };
}

/**
 * Where the next thing waiting on me is: cards first, oldest first, because
 * they expire; then conversations where I was addressed, oldest first.
 *
 * From `current`, the one after it — so pressing the key again walks the
 * list rather than staying put. Null when nothing is waiting.
 */
export function nextWaiting(
  approvals: ApprovalState,
  unread: Record<ConversationKey, Unread>,
  myUserId: string,
  current: ConversationKey,
  now = Date.now(),
): ConversationKey | null {
  const keys: ConversationKey[] = [];
  for (const approval of waitingApprovals(approvals, now)) {
    if (approval.ownerUserId !== myUserId || approval.private) continue;
    const key = approvalKey(approval);
    if (key && !keys.includes(key)) keys.push(key);
  }
  const mentioned = (Object.entries(unread) as [ConversationKey, Unread][])
    .filter(([, entry]) => entry.mentioned)
    .sort(([, a], [, b]) => a.newestAt - b.newestAt);
  for (const [key] of mentioned) if (!keys.includes(key)) keys.push(key);

  if (keys.length === 0) return null;
  const at = keys.indexOf(current);
  if (at === -1) return keys[0]!;
  // Standing on the only one: there is nowhere further to go.
  return keys.length === 1 ? null : keys[(at + 1) % keys.length]!;
}
