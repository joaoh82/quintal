import type { MembershipRole } from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  findMembership,
  findWorkspaceById,
  type Database,
  type Workspace,
} from '@quintal/shared/db';

/**
 * The office a request is *in*.
 *
 * Every page used to answer this with `ensurePersonalWorkspace` — the office
 * you own — which was right for as long as that was the only office anybody
 * could be in. A guest broke it: their session admits them to the office
 * that invited them, the room puts them there, and the header above the room
 * named their own empty office instead. Two answers to "where am I" on one
 * screen.
 *
 * One rule, in one place. A guest is in the office their session was
 * granted; a member is in their own. When a member can belong to several,
 * the switcher that decides between them changes this function and nothing
 * else.
 */
export interface CurrentOffice {
  workspace: Workspace;
  /** `guest` for a visitor; otherwise their membership. */
  role: MembershipRole | 'guest';
}

export interface OfficeSession {
  user: { id: string; name: string; pubkey: string };
  session: { isGuest: boolean; guestWorkspaceId?: string | null };
}

export async function currentOffice(
  db: Database,
  session: OfficeSession,
): Promise<CurrentOffice | null> {
  if (session.session.isGuest) {
    const granted = session.session.guestWorkspaceId;
    if (!granted) return null;
    const workspace = await findWorkspaceById(db, granted);
    return workspace ? { workspace, role: 'guest' } : null;
  }

  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });
  const membership = await findMembership(db, session.user.id, workspace.id);
  // `ensurePersonalWorkspace` returns the office this person *owns* and
  // writes the owner membership when it creates one, so a missing row here
  // is the safety net for an account whose sign-up was cut short — not a
  // demotion. Owner is what the row would say.
  return { workspace, role: (membership?.role as MembershipRole | undefined) ?? 'owner' };
}
