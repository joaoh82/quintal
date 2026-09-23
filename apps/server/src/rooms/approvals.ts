import {
  APPROVAL_EXPIRY_GRACE_MS,
  APPROVAL_KEEP_RESOLVED_MS,
  type ApprovalDecidePayload,
  type ApprovalOptionId,
  type PublicApprovalRequest,
} from '@quintal/shared';

/**
 * Who may answer a tool approval, and whether this answer still counts.
 *
 * Pure, because every one of these rules is a security rule and a security
 * rule that can only be exercised by standing up a websocket is a security
 * rule nobody exercises. The room does the routing; this decides.
 */

/** One approval the office is holding, and what it knows about it. */
export interface TrackedApproval {
  value: PublicApprovalRequest;
  /** The agent's socket, so a disconnect finds its questions. */
  owner: string;
  /** The channel or zone conversation the card belongs to. */
  conversationId: string;
  /** Where the agent stood when it asked — earshot is judged from there. */
  x: number;
  y: number;
  /** Set once somebody's answer has been sent to the agent. */
  decidedBy?: string;
  /** Set once the harness said how it ended; the card stops offering buttons. */
  resolvedAt?: number;
}

export type DecisionVerdict =
  | { ok: true; optionId: ApprovalOptionId }
  /** Say nothing useful about requests that are not this person's to see. */
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'missing_scope'; message: string }
  | { ok: false; code: 'invalid_payload'; message: string };

/**
 * Whether this person may answer this request, right now, with this option.
 *
 * Four separate checks, and all four matter. The owner check is the whole
 * point. The expiry check stops an answer landing on a question the runtime
 * has already been told no about. The already-decided check makes a second
 * click a no-op rather than a second decision. And the option check is what
 * makes hiding a button insufficient: a crafted `approval_decide` naming
 * `allow_always` on a card that offered `allow_once` is refused here, not
 * hopefully filtered by a browser.
 */
export function judgeDecision(
  tracked: TrackedApproval | undefined,
  decide: ApprovalDecidePayload,
  actorUserId: string,
  now = Date.now(),
): DecisionVerdict {
  if (!tracked) return { ok: false, code: 'not_found', message: 'That request is no longer waiting.' };
  if (tracked.value.ownerUserId !== actorUserId) {
    return {
      ok: false,
      code: 'missing_scope',
      message: `Only ${tracked.value.ownerName} can answer ${tracked.value.agentName}'s requests.`,
    };
  }
  if (tracked.resolvedAt !== undefined || tracked.decidedBy !== undefined) {
    return { ok: false, code: 'not_found', message: 'That request has already been answered.' };
  }
  if (now >= tracked.value.expiresAt) {
    return { ok: false, code: 'not_found', message: 'That request timed out before it was answered.' };
  }
  if (!tracked.value.options.some((option) => option.id === decide.optionId)) {
    return { ok: false, code: 'invalid_payload', message: 'That is not one of the options offered.' };
  }
  return { ok: true, optionId: decide.optionId };
}

/**
 * Whether this person should see this card at all.
 *
 * The same audience rule as activity — channel membership, or earshot, or a
 * zone they are following — because the card sits in the transcript beside
 * the turn it belongs to. The owner is separately guaranteed a copy; see
 * `needsPrivateCopy`.
 */
export function canSeeApproval(
  tracked: Pick<TrackedApproval, 'value' | 'x' | 'y'>,
  viewer: {
    x: number;
    y: number;
    /** Whether the viewer is a member of the card's channel, when it has one. */
    inChannel: boolean;
    /** The zone this viewer is reading, if any. */
    followedZone: string | null;
  },
  radius: number,
): boolean {
  if (tracked.value.channelId) return viewer.inChannel;
  if (viewer.followedZone && viewer.followedZone === tracked.value.zoneId) return true;
  return Math.hypot(viewer.x - tracked.x, viewer.y - tracked.y) <= radius;
}

/**
 * Whether the owner needs a private copy of this card.
 *
 * An agent can be in a channel its owner is not, and can be asked something
 * while standing on the far side of the office. Either way the owner is the
 * only person who can answer, and a question nobody can see is the invisible
 * wait this whole ticket exists to end. So: when the conversation would not
 * reach them, the card goes to them directly instead, marked private, and is
 * shown in their own corner rather than in anybody's transcript.
 */
export function needsPrivateCopy(visibleToOwner: boolean): boolean {
  return !visibleToOwner;
}

/** Cards past their deadline that the harness has not spoken for. */
export function expiredApprovals(
  tracked: Iterable<[string, TrackedApproval]>,
  now = Date.now(),
): string[] {
  const stale: string[] = [];
  for (const [requestId, entry] of tracked) {
    if (entry.resolvedAt === undefined && now >= entry.value.expiresAt + APPROVAL_EXPIRY_GRACE_MS) {
      stale.push(requestId);
    }
  }
  return stale;
}

/** Resolved cards old enough that nobody is still looking at them. */
export function forgettableApprovals(
  tracked: Iterable<[string, TrackedApproval]>,
  now = Date.now(),
): string[] {
  const done: string[] = [];
  for (const [requestId, entry] of tracked) {
    if (entry.resolvedAt !== undefined && now - entry.resolvedAt > APPROVAL_KEEP_RESOLVED_MS) {
      done.push(requestId);
    }
  }
  return done;
}
