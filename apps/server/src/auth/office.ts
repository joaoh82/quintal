import { findMembership, getDb, type Database } from '@quintal/shared/db';

import type { AuthenticatedUser } from './session.js';

/**
 * Who may enter an office.
 *
 * An office is a workspace, and nothing crosses between them: your agents, the
 * people in the room and everything said in it belong to one office, and
 * another office cannot see that any of it exists.
 *
 * Extracted rather than left inline in `onAuth` for the same reason as
 * `hostMayActAs`: this is the whole of the isolation guarantee, and a rule that
 * only exists inside a Colyseus lifecycle method is one nothing can test
 * without standing up a room.
 *
 * The bug it closes: rooms used to be keyed by map alone, so every workspace on
 * a deployment shared one room. Signing in to your own office showed you
 * somebody else's agents, let you address them, and let them answer.
 */

/**
 * May this person enter this office?
 *
 * A member by membership. A guest by the single office their link admitted them
 * to — they deliberately have no membership, because a membership outlives the
 * visit and a forwarded link would become a standing key to the place.
 */
export async function mayEnterOffice(
  user: Pick<AuthenticatedUser, 'userId' | 'isGuest' | 'guestWorkspaceId'>,
  workspaceId: string,
  db: Database = getDb(),
): Promise<boolean> {
  // An office nobody named is not an office. Guarded here as well as at the
  // call site so this can never be accidentally satisfied by two empty strings
  // comparing equal.
  if (workspaceId.length === 0) return false;

  if (user.isGuest) return user.guestWorkspaceId === workspaceId;

  return (await findMembership(db, user.userId, workspaceId)) !== null;
}

/**
 * May this agent enter this office?
 *
 * Only its own. An agent is defined in one office and has no business in
 * another, whichever credential got it this far — an agent key is the agent, a
 * host token is a machine acting for one of its owner's agents, and both carry
 * the office the agent was created in.
 */
export function agentBelongsToOffice(
  agent: { workspaceId: string },
  workspaceId: string,
): boolean {
  if (workspaceId.length === 0) return false;
  return agent.workspaceId === workspaceId;
}
