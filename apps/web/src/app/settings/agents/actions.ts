'use server';

import {
  DEFAULT_AGENT_SCOPES,
  runtimeById,
  isAgentScope,
  isAgentSpriteKey,
  modelChoice,
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
  listHostsForWorkspace,
  revokeAgent,
  revokeHostToken,
  forgetHostReport,
  setAgentEnabled,
  setAgentLaunch,
  setAgentProfile,
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

/**
 * A signed-in, non-guest session.
 *
 * Everything in this file creates or destroys something durable: agents, the
 * machine credentials that let a computer run them, and the assignments between
 * the two. A guest link is a time-boxed visit, and none of that should outlive
 * it.
 *
 * The sharpest case is the machine credential. A guest could mint a `qh_` token
 * for their own workspace and — from the desktop app's devtools — hand it to
 * `remember_host_token`, leaving somebody else's computer holding *their*
 * machine token and booting *their* fleet. `POST /api/host/register` already
 * refuses guests; this is the other door into the same room.
 */
async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Not signed in.');
  if (session.session.isGuest) {
    throw new Error('Guests cannot manage agents or machines.');
  }
  return session;
}

/**
 * The model an owner asked for, checked against what that machine's runtime
 * actually offered.
 *
 * Empty means the runtime's default and is always fine. Anything else has to
 * be a choice the machine reported for that runtime — the picker only offers
 * those, and this is the same rule applied where the picker cannot be
 * trusted. A model id that never came from the runtime would either be
 * refused by the harness at every session (it will not run on a model it was
 * not offered) or, worse, silently meaningless; better to say so here.
 */
async function modelFor(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  hostLabel: string,
  runtimeId: string,
  raw: FormDataEntryValue | null,
): Promise<{ modelId: string | null } | { error: string }> {
  const modelId = String(raw ?? '').trim();
  if (modelId.length === 0) return { modelId: null };

  const host = (await listHostsForWorkspace(db, workspaceId)).find(
    (row) => row.label === hostLabel,
  );
  const status = host?.runtimes.find((entry) => entry.id === runtimeId);
  if (!modelChoice(status, modelId)) {
    return {
      error: `${hostLabel} did not report a model "${modelId}" for ${runtimeById(runtimeId)?.label ?? runtimeId}. Pick one it offers, or leave it on the default.`,
    };
  }
  return { modelId };
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

    let modelId: string | null = null;
    if (wantsLaunch) {
      const model = await modelFor(db, workspace.id, hostLabel, runtimeId, formData.get('modelId'));
      if ('error' in model) return { ok: false, error: model.error };
      modelId = model.modelId;
    }

    const created = await createAgent(db, {
      workspaceId: workspace.id,
      ownerUserId: session.user.id,
      name,
      spriteKey,
      // Normalised again inside `createAgent`; passed raw so there is one place
      // that decides what a description and an instruction may contain.
      description: String(formData.get('description') ?? ''),
      instructions: String(formData.get('instructions') ?? ''),
      scopes: scopes.length > 0 ? scopes : DEFAULT_AGENT_SCOPES,
      ...(wantsLaunch ? { launch: { runtimeId, repoSpec, hostLabel, modelId } } : {}),
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

/**
 * Change what an agent says it is, and how it was told to behave.
 *
 * Same gate as revoking and assigning: your own agents, or anyone's if you run
 * the office. Rewriting somebody else's agent's instructions would be a way to
 * change what their agent does while their name stays on it.
 */
export interface SaveAgentProfileState {
  ok: boolean;
  error?: string;
  /** The agent the last save was for, so one row's result cannot show on another. */
  agentId?: string;
}

export async function saveAgentProfileAction(
  _previous: SaveAgentProfileState,
  formData: FormData,
): Promise<SaveAgentProfileState> {
  const session = await requireSession();
  const db = getDb();

  const agentId = String(formData.get('agentId') ?? '');
  const agent = await findAgentById(db, agentId);
  // Returned rather than thrown. A thrown server action reaches the person as
  // a blank screen or nothing at all, and "nothing happened" is exactly what
  // this form was already guilty of.
  if (!agent) return { ok: false, error: 'No such agent.', agentId };

  if (!(await canAdministerAgent(db, session.user.id, agent))) {
    return { ok: false, error: 'That is not your agent to change.', agentId };
  }

  // Absent means "leave it alone" — `setAgentProfile` reads undefined that way,
  // so a form that posts only one field cannot blank the other.
  const field = (name: string): string | undefined => {
    const raw = formData.get(name);
    return raw === null ? undefined : String(raw);
  };

  await setAgentProfile(db, agentId, {
    description: field('description'),
    instructions: field('instructions'),
  });

  revalidatePath('/settings/agents');
  // The office reads both on connect, so a change lands for anybody joining
  // now; a running agent is restarted by its host on the next fleet poll.
  revalidatePath('/office');
  return { ok: true, agentId };
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

  const model = await modelFor(db, agent.workspaceId, hostLabel, runtimeId, formData.get('modelId'));
  if ('error' in model) throw new Error(model.error);

  await setAgentLaunch(db, agentId, { runtimeId, repoSpec, hostLabel, modelId: model.modelId });
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
