'use server';

import {
  DEFAULT_AGENT_SCOPES,
  isAgentScope,
  isAgentSpriteKey,
  normaliseAgentName,
  type AgentScope,
} from '@quintal/shared';
import {
  canAdministerAgent,
  createAgent,
  ensurePersonalWorkspace,
  findAgentById,
  getDb,
  revokeAgent,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { auth } from '@/lib/auth';

/**
 * Creating and revoking agents.
 *
 * Two rules run through both actions: an agent is always owned by a specific
 * human, and the plaintext key exists exactly once — in the response of the
 * action that created it. It is never written down, never re-derivable, and
 * never sent again.
 */

async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  return session;
}

export interface CreateAgentState {
  ok: boolean;
  /** Present exactly once, on success. Show it, then let it go. */
  key?: string;
  agentName?: string;
  error?: string;
}

export async function createAgentAction(
  _previous: CreateAgentState,
  formData: FormData,
): Promise<CreateAgentState> {
  try {
    const session = await requireSession();
    const db = getDb();

    const name = normaliseAgentName(String(formData.get('name') ?? ''));
    if (name.length === 0) return { ok: false, error: 'Give the agent a name.' };

    const spriteRaw = String(formData.get('spriteKey') ?? 'slate');
    const spriteKey = isAgentSpriteKey(spriteRaw) ? spriteRaw : 'slate';

    const scopes = formData
      .getAll('scopes')
      .map(String)
      .filter((scope): scope is AgentScope => isAgentScope(scope));

    const workspace = await ensurePersonalWorkspace(db, {
      userId: session.user.id,
      name: session.user.name,
      email: session.user.email,
    });

    const created = await createAgent(db, {
      workspaceId: workspace.id,
      ownerUserId: session.user.id,
      name,
      spriteKey,
      scopes: scopes.length > 0 ? scopes : DEFAULT_AGENT_SCOPES,
    });

    revalidatePath('/settings/agents');
    return { ok: true, key: created.key, agentName: created.name };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not create the agent.',
    };
  }
}

export async function revokeAgentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getDb();

  const agentId = String(formData.get('agentId') ?? '');
  const agent = await findAgentById(db, agentId);
  if (!agent) throw new Error('No such agent.');

  // Members revoke their own; workspace owners and admins revoke anyone's.
  const allowed = await canAdministerAgent(db, session.user.id, agent);
  if (!allowed) throw new Error('That is not your agent to revoke.');

  await revokeAgent(db, agentId, session.user.id);
  revalidatePath('/settings/agents');
}
