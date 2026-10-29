'use server';

import {
  GITHUB_API_DEFAULT,
  GithubClient,
  GithubError,
  mayManageGithubToken,
  normaliseGithubRepos,
  normaliseGithubToken,
  type OfficeGithubRef,
} from '@quintal/shared';
import { clearOfficeGithub, describeOfficeGithub, getDb, setOfficeGithub, setOfficeGithubRepos } from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';
import { currentOffice } from '@/lib/workspace';

/**
 * The office's GitHub token: put in, replaced, or taken out by an owner or
 * admin. The token is tried against GitHub before it is kept, so what is
 * saved is known to work and known to be whose; it is never read back to a
 * page. The game server picks it up on its next look, within a minute.
 */

export interface GithubState {
  ok: boolean;
  github?: OfficeGithubRef;
  error?: string;
}

async function officeAdmin(): Promise<{ workspaceId: string; userId: string } | { error: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: 'Not signed in.' };
  if (session.session.isGuest) return { error: 'You are visiting this office; its owner or an admin connects GitHub.' };
  const here = await currentOffice(getDb(), session);
  if (!here) return { error: 'Not in an office.' };
  if (!mayManageGithubToken(here.role)) return { error: 'Only the office’s owner or an admin connects GitHub.' };
  return { workspaceId: here.workspace.id, userId: session.user.id };
}

export async function saveGithubTokenAction(_previous: GithubState, formData: FormData): Promise<GithubState> {
  try {
    const who = await officeAdmin();
    if ('error' in who) return { ok: false, error: who.error };
    const token = normaliseGithubToken(formData.get('token'));
    if (!token) return { ok: false, error: 'That is not a GitHub token. Paste the token itself, as GitHub showed it.' };

    // Tried before kept: a token that does not work is not worth a row, and
    // whose it is goes on the row so the page can say so without the token.
    let login: string;
    try {
      ({ login } = await new GithubClient(token, { apiBase: process.env.QUINTAL_GITHUB_API ?? GITHUB_API_DEFAULT }).viewer());
    } catch (error: unknown) {
      return { ok: false, error: error instanceof GithubError ? error.message : 'GitHub could not be reached to check the token.' };
    }
    const db = getDb();
    // The list may come with the token the first time; on its own it is the other action.
    const repos = formData.get('repos') === null ? undefined : normaliseGithubRepos(formData.get('repos'));
    if (repos === null) return { ok: false, error: 'Name repositories as owner/name, one per line.' };
    await setOfficeGithub(db, { workspaceId: who.workspaceId, token, login, setByUserId: who.userId, ...(repos ? { repos } : {}) });
    revalidatePath('/settings');
    return { ok: true, github: await describeOfficeGithub(db, who.workspaceId) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the token.' };
  }
}

/**
 * The repositories the office may look at and act in with its token. The
 * rule that keeps the token from being every member's write access to
 * everything it reaches: only an owner or admin names them, and a pull
 * request anywhere else is shown as reported and nothing more.
 */
export async function saveGithubReposAction(_previous: GithubState, formData: FormData): Promise<GithubState> {
  try {
    const who = await officeAdmin();
    if ('error' in who) return { ok: false, error: who.error };
    const repos = normaliseGithubRepos(formData.get('repos') ?? '');
    if (repos === null) return { ok: false, error: 'Name repositories as owner/name, one per line, fifty at most.' };
    const db = getDb();
    if (!(await setOfficeGithubRepos(db, who.workspaceId, repos))) {
      return { ok: false, error: 'Connect a token first; the list is what the office may do with it.' };
    }
    revalidatePath('/settings');
    return { ok: true, github: await describeOfficeGithub(db, who.workspaceId) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save the list.' };
  }
}

export async function removeGithubTokenAction(_previous: GithubState): Promise<GithubState> {
  try {
    const who = await officeAdmin();
    if ('error' in who) return { ok: false, error: who.error };
    const db = getDb();
    await clearOfficeGithub(db, who.workspaceId);
    revalidatePath('/settings');
    return { ok: true, github: await describeOfficeGithub(db, who.workspaceId) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not remove the token.' };
  }
}
