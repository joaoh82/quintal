import {
  describeResolution,
  type ApprovalOptionId,
  type PublicApprovalRequest,
  type PublicApprovalResolved,
} from '@quintal/shared';

import { channelKey, zoneKey, type ConversationKey } from './conversationKey';

/**
 * Approval cards, as this client knows them.
 *
 * Kept apart from the store and from React for the same reason unread is:
 * what a card should say, and whether its buttons still do anything, is a
 * set of rules worth pinning without a browser. The office is the authority
 * on all of it — nothing here decides that an answer was accepted, only what
 * to show while the answer is in flight.
 */

/** Cards remembered after they stopped waiting, so a transcript keeps the record. */
const KEEP_RESOLVED = 50;

export interface ApprovalState {
  /** Every card we have been told about, newest word per request id. */
  requests: Record<string, PublicApprovalRequest>;
  /** How each one ended, once the office has said. */
  resolved: Record<string, PublicApprovalResolved>;
  /** Answers this browser has sent and not yet seen resolved. */
  sent: Record<string, ApprovalOptionId>;
}

export const EMPTY_APPROVALS: ApprovalState = { requests: {}, resolved: {}, sent: {} };

/** Where a card belongs: the channel it was asked in, or the zone. */
export function approvalKey(approval: PublicApprovalRequest): ConversationKey | null {
  if (approval.channelId) return channelKey(approval.channelId);
  return approval.zoneId ? zoneKey(approval.zoneId) : null;
}

/**
 * The office has told us about a card — a new one, or one it is showing again.
 *
 * A re-send is how a question comes back after its agent's socket dropped: the
 * office closed it `interrupted`, the agent reconnected, and the office
 * resumed it. The client has to let go of that resolution or the card keeps
 * rendering as over — `approvalStatus` reads `resolved` first, so a stale
 * entry there outranks the live request and the owner is left looking at
 * "Interrupted" with no buttons on a question that is waiting for them.
 *
 * Only `interrupted` is dropped. A card the harness answered, denied or let
 * expire is over for good, and no re-send may bring its buttons back.
 */
export function receiveApproval(
  state: ApprovalState,
  approval: PublicApprovalRequest,
): ApprovalState {
  const requests = { ...state.requests, [approval.requestId]: approval };
  if (state.resolved[approval.requestId]?.resolution !== 'interrupted') {
    return { ...state, requests };
  }
  const { [approval.requestId]: _revived, ...resolved } = state.resolved;
  return { ...state, requests, resolved };
}

/**
 * The office says this one stopped waiting.
 *
 * The sent answer is dropped at the same moment: whatever happened, this
 * browser is no longer waiting to hear about its own click, and a card that
 * kept saying "sending…" after the outcome landed would be lying.
 */
export function receiveResolution(
  state: ApprovalState,
  resolved: PublicApprovalResolved,
): ApprovalState {
  const { [resolved.requestId]: _sent, ...sent } = state.sent;
  const next = { ...state.resolved, [resolved.requestId]: resolved };
  const ids = Object.keys(next);
  if (ids.length > KEEP_RESOLVED) {
    for (const id of ids
      .sort((a, b) => (next[a]!.receivedAt ?? 0) - (next[b]!.receivedAt ?? 0))
      .slice(0, ids.length - KEEP_RESOLVED))
      delete next[id];
  }
  return { ...state, resolved: next, sent };
}

/** An answer is on its way to the office. Optimistic about nothing but the click. */
export function noteSent(
  state: ApprovalState,
  requestId: string,
  optionId: ApprovalOptionId,
): ApprovalState {
  return { ...state, sent: { ...state.sent, [requestId]: optionId } };
}

/**
 * A request the office refused to take an answer for — it had already been
 * answered, or it timed out under us. Forget the click; the card goes back
 * to showing what it actually is.
 */
export function clearSent(state: ApprovalState, requestId: string): ApprovalState {
  const { [requestId]: _dropped, ...sent } = state.sent;
  return { ...state, sent };
}

export type ApprovalStatus =
  /** Waiting on somebody, with buttons live for the one who may click them. */
  | { kind: 'waiting' }
  /** This browser clicked; the office has not said what came of it yet. */
  | { kind: 'sending'; optionId: ApprovalOptionId }
  /** Over. `label` is what to show where the buttons were. */
  | { kind: 'resolved'; label: string };

/**
 * What one card should say right now.
 *
 * The deadline is checked locally as well as by the office, because a
 * browser that lost its socket must not keep offering a button that cannot
 * possibly be answered any more. It reads as over; it does not claim to know
 * which way, because it does not.
 */
export function approvalStatus(
  state: ApprovalState,
  approval: PublicApprovalRequest,
  now = Date.now(),
): ApprovalStatus {
  const resolved = state.resolved[approval.requestId];
  if (resolved) return { kind: 'resolved', label: describeResolution(resolved) };
  if (now >= approval.expiresAt) return { kind: 'resolved', label: 'No answer in time — denied' };
  const sent = state.sent[approval.requestId];
  if (sent) return { kind: 'sending', optionId: sent };
  return { kind: 'waiting' };
}

/** Cards still waiting, oldest first. */
export function waitingApprovals(
  state: ApprovalState,
  now = Date.now(),
): PublicApprovalRequest[] {
  return Object.values(state.requests)
    .filter((approval) => approvalStatus(state, approval, now).kind !== 'resolved')
    .sort((a, b) => a.askedAt - b.askedAt);
}

/**
 * Conversations with a card waiting for this person, so their tabs can say
 * so. Only the owner's own: an indicator on somebody else's question would
 * be an interruption about work they cannot act on.
 */
export function attentionKeys(
  state: ApprovalState,
  myUserId: string,
  now = Date.now(),
): Set<ConversationKey> {
  const keys = new Set<ConversationKey>();
  for (const approval of waitingApprovals(state, now)) {
    if (approval.ownerUserId !== myUserId || approval.private) continue;
    const key = approvalKey(approval);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Cards the office sent straight to the owner because the conversation they
 * were asked in would not have reached them. Shown in their own corner: the
 * transcript they belong to is not one this person can open.
 */
export function privateApprovals(
  state: ApprovalState,
  myUserId: string,
  now = Date.now(),
): PublicApprovalRequest[] {
  return waitingApprovals(state, now).filter(
    (approval) => approval.private === true && approval.ownerUserId === myUserId,
  );
}
