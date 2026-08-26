'use server';

import {
  DEFAULT_AGENT_SCOPES,
  runtimeById,
  isAgentScope,
  isAgentSpriteKey,
  normaliseAgentName,
  type AgentScope,
} from '@quintal/shared';
import {
  canAdministerAgent,
  createAgent,
  createHostToken,
  ensurePersonalWorkspace,
  findAgentById,
  getDb,
  listHostTokens,
  revokeAgent,
  revokeHostToken,
  forgetHostReport,
  setAgentEnabled,
  setAgentLaunch,
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
      pubkey: session.user.pubkey,
    });

    // Launch details are all-or-nothing: a runtime with no machine has nowhere
    // to run, and a machine with no runtime has nothing to run. Given none, the
    // agent is created exactly as before and started by hand with its key.
    const runtimeId = String(formData.get('runtimeId') ?? '').trim();
    const repoSpec = String(formData.get('repoSpec') ?? '').trim();
    const hostLabel = String(formData.get('hostLabel') ?? '').trim();
    const wantsLaunch = runtimeId.length > 0 && hostLabel.length > 0;

    if (wantsLaunch) {
      const runtime = runtimeById(runtimeId);
      if (!runtime) return { ok: false, error: `Unknown runtime "${runtimeId}".` };
      if (runtime.acp.kind === 'none') {
        return {
          ok: false,
          error: `${runtime.label} has no ACP mode, so nothing can drive it.`,
        };
      }
      if (repoSpec.length === 0) {
        return { ok: false, error: 'Say which repo it works in, or * for all of them.' };
      }
    }

    const created = await createAgent(db, {
      workspaceId: workspace.id,
      ownerUserId: session.user.id,
      name,
      spriteKey,
      scopes: scopes.length > 0 ? scopes : DEFAULT_AGENT_SCOPES,
      ...(wantsLaunch ? { launch: { runtimeId, repoSpec, hostLabel } } : {}),
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


// --- machines --------------------------------------------------------------

export interface HostTokenState {
  ok: boolean;
  /** Present exactly once, like an agent key. */
  token?: string;
  label?: string;
  error?: string;
}

/**
 * Register a machine.
 *
 * The token is shown once and stored only as a hash, exactly like an agent key
 * — but it is more powerful than one, so the UI says so rather than leaving the
 * reader to work it out.
 */
export async function createHostTokenAction(
  _previous: HostTokenState,
  formData: FormData,
): Promise<HostTokenState> {
  try {
    const session = await requireSession();
    const db = getDb();
    const workspace = await ensurePersonalWorkspace(db, {
      userId: session.user.id,
      name: session.user.name,
      pubkey: session.user.pubkey,
    });

    const label = String(formData.get('label') ?? '').trim();
    if (label.length === 0) return { ok: false, error: 'Name the machine.' };

    const existing = await listHostTokens(db, workspace.id);
    if (existing.some((row) => row.label === label && row.revokedAt === null)) {
      return { ok: false, error: `"${label}" is already registered. Revoke it first.` };
    }

    const created = await createHostToken(db, {
      workspaceId: workspace.id,
      ownerUserId: session.user.id,
      label,
    });

    revalidatePath('/settings/agents');
    return { ok: true, token: created.token, label: created.label };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not register the machine.',
    };
  }
}

export async function revokeHostTokenAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const id = String(formData.get('tokenId') ?? '');
  // Only your own machines: a host token is a credential for one person's
  // fleet, so revoking somebody else's is not an admin action, it is a mistake.
  const mine = (await listHostTokens(db, workspace.id)).find(
    (row) => row.id === id && row.ownerUserId === session.user.id,
  );
  if (!mine) throw new Error('That is not your machine to revoke.');

  await revokeHostToken(db, id);
  revalidatePath('/settings/agents');
}


/**
 * Move an existing agent to a machine, or take it off one.
 *
 * A running fleet notices within a poll: the machine losing it stops it, the
 * machine gaining it starts it, and agents that did not change keep their
 * sessions. Which is why this is a plain form and not a warning-laden dialog —
 * reassigning is cheap and reversible.
 */
export async function assignAgentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getDb();

  const agentId = String(formData.get('agentId') ?? '');
  const agent = await findAgentById(db, agentId);
  if (!agent) throw new Error('No such agent.');

  // The same gate as revoking: your own agents, or anyone's if you run the
  // workspace. Assigning somebody else's agent to your laptop would be a way
  // to run their fleet on your machine.
  if (!(await canAdministerAgent(db, session.user.id, agent))) {
    throw new Error('That is not your agent to assign.');
  }

  const hostLabel = String(formData.get('hostLabel') ?? '').trim();
  if (hostLabel.length === 0) {
    await setAgentLaunch(db, agentId, null);
    revalidatePath('/settings/agents');
    return;
  }

  const runtimeId = String(formData.get('runtimeId') ?? '').trim();
  const runtime = runtimeById(runtimeId);
  if (!runtime) throw new Error(`Unknown runtime "${runtimeId}".`);
  if (runtime.acp.kind === 'none') {
    throw new Error(`${runtime.label} has no ACP mode, so nothing can drive it.`);
  }

  const repoSpec = String(formData.get('repoSpec') ?? '').trim();
  if (repoSpec.length === 0) {
    throw new Error('Say which repo it works in, or * for all of them.');
  }

  await setAgentLaunch(db, agentId, { runtimeId, repoSpec, hostLabel });
  revalidatePath('/settings/agents');
}

/**
 * Turn an agent on or off without destroying it.
 *
 * Same gate as assigning: your own agents, or anyone's if you run the
 * workspace. Being able to switch off somebody else's agent is a smaller power
 * than being able to run it, but it is still theirs.
 */
export async function setAgentEnabledAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getDb();

  const agentId = String(formData.get('agentId') ?? '');
  const agent = await findAgentById(db, agentId);
  if (!agent) throw new Error('No such agent.');

  if (!(await canAdministerAgent(db, session.user.id, agent))) {
    throw new Error('That is not your agent to change.');
  }

  await setAgentEnabled(db, agentId, formData.get('enabled') === 'true');
  revalidatePath('/settings/agents');
}

/**
 * Remove a machine's report from the office.
 *
 * Only your own: a report describes what somebody's computer has installed on
 * it, and it is theirs to withdraw. It does not revoke anything — the machine
 * reappears the next time its harness connects, which is the correct behaviour
 * for a machine that still exists and the point of it for one that does not.
 */
export async function forgetHostReportAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const db = getDb();

  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const label = String(formData.get('label') ?? '').trim();
  if (label.length === 0) throw new Error('Which machine?');

  await forgetHostReport(db, {
    workspaceId: workspace.id,
    ownerUserId: session.user.id,
    label,
  });
  revalidatePath('/settings/agents');
}
