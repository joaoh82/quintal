import type { ActivityState, AgentActivity, BoardPullReviewOutcome, BoardPullReviewRef } from '@quintal/shared';

/**
 * When a review asked for from the board is done. The ask's line goes out
 * with a request id; the agent's turn on it reports that id back in its
 * activity, batched beside others or alone, and the turn's last state is
 * how the review ended. No harness change and no guessing from GitHub,
 * whose reviewer is whoever the agent's `gh` signs in as.
 */

/**
 * What a turn's state says of the review it was on: `reviewed` for a turn
 * that completed, `stopped` for one that will not finish, null while it
 * may yet — `disconnected` included, since a harness that comes back
 * resumes the turn.
 */
export function reviewOutcomeOf(state: ActivityState): BoardPullReviewOutcome | null {
  switch (state) {
    case 'completed':
      return 'reviewed';
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return 'stopped';
    default:
      return null;
  }
}

/**
 * The asks this agent's turn finished, and how: each still open one whose
 * request id the turn carries. Empty for a turn still going, or one that
 * was on nothing asked from the board.
 */
export function reviewsFinishedBy(
  reviews: readonly BoardPullReviewRef[],
  agentId: string,
  activity: Pick<AgentActivity, 'state' | 'requestId' | 'requestIds'>,
): { review: BoardPullReviewRef; outcome: BoardPullReviewOutcome }[] {
  const outcome = reviewOutcomeOf(activity.state);
  if (!outcome) return [];
  const ids = new Set([activity.requestId, ...(activity.requestIds ?? [])]);
  return reviews
    .filter((review) => review.agentId === agentId && review.finishedAt === null && review.requestId !== null && ids.has(review.requestId))
    .map((review) => ({ review, outcome }));
}
