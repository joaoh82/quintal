/**
 * When an agent's work began, as the office keeps it.
 *
 * `workingIn` says where an agent is working; this is the clock beside it,
 * so a channel row can show how long its agent has been at it. The rule is
 * deliberately blunt: the stamp is taken when an agent goes from idle to
 * working, held for as long as it keeps working — whichever conversations
 * that work moves through — and dropped when it is idle again. A turn that
 * starts while another is still running does not restart the clock; the
 * clock answers "how long has this agent been busy", which is what somebody
 * waiting on it wants to know.
 *
 * Pure, and on the office's clock: the harness never sends a time, so no
 * client has to reconcile anybody's clock with its own.
 */
export function workingSinceAfter(
  previous: { workingIn: string; workingSince: number },
  nextWorkingIn: string,
  now: number,
): number {
  if (nextWorkingIn.length === 0) return 0;
  if (previous.workingIn.length === 0 || previous.workingSince === 0) return now;
  return previous.workingSince;
}
