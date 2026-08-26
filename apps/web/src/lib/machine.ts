'use client';

import { getHost, type HostBridge } from './host';

/**
 * Registering the computer you are signed in from.
 *
 * The `qh_` token exists because a browser office is blind — it cannot see your
 * laptop, so a person carries a secret across the gap to prove the two belong
 * together. The desktop app is not blind: it is signed in, and it holds a key in
 * the OS keychain. So it asks, and keeps the answer.
 *
 * ## Why it asks for a name instead of taking one
 *
 * The hostname is a fine default and a poor decision. `Joaos-MacBook-Pro-2` is
 * not a name anybody would choose to read in a list, and — worse — registering
 * under it silently ignores a machine the same person already registered by
 * hand. Agents are pinned to a machine *by label*, so inventing a second name
 * for one computer orphans every agent assigned to the first.
 *
 * Naming it is therefore a one-time question rather than an assumption, and
 * reusing an existing name is the adoption path: `registerMachineForUser`
 * replaces the live token for that label, so this app takes over the machine
 * the agents are already assigned to instead of standing up a rival.
 *
 * Three properties this has to hold, all learned the hard way:
 *
 * - **It never blocks sign-in.** Registration is how you *run agents*, not how
 *   you get into the room. A machine that failed to register is a degraded app;
 *   a sign-in that failed because of it would be a broken one.
 * - **It asks at most once per machine.** Only the hash is stored server-side,
 *   so registering again cannot return the same token — it mints a new one and
 *   revokes the old. Asking on every launch would orphan the previous launch's
 *   token every time.
 * - **A refusal is not a failure.** A guest session is *supposed* to be turned
 *   down, and saying "couldn't register" there would report the safety rail as
 *   a bug.
 */
export type RegistrationOutcome =
  /** A browser. There is no machine here to register. */
  | { kind: 'not-hosted' }
  | { kind: 'registered'; label: string }
  /** The office said no, and meant it — a guest session, most likely. */
  | { kind: 'refused'; reason: string }
  /** Something went wrong. Worth showing, not worth interrupting anyone over. */
  | { kind: 'failed'; reason: string };

async function reasonFrom(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === 'object' && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  return `the office answered ${response.status}`;
}

/**
 * Make sure the office knows about this computer.
 *
 * `host` and `fetchImpl` are injectable so this can be tested without a Tauri
 * runtime or a server — the interesting cases here are the refusals, and those
 * are exactly the ones a live test would be least likely to reach.
 */
export type NamingPrompt =
  /** A browser, or a machine that has already registered. Ask nothing. */
  | { kind: 'settled' }
  /** Ask, offering this as the default. */
  | { kind: 'ask'; suggested: string }
  | { kind: 'failed'; reason: string };

/**
 * Should this app ask the person to name their computer?
 *
 * Separate from registering so the prompt can be rendered without a side
 * effect: deciding whether to ask must not itself claim a machine.
 */
export async function machineNaming(
  host: HostBridge | null = getHost(),
): Promise<NamingPrompt> {
  if (!host) return { kind: 'settled' };
  try {
    const status = await host.hostStatus();
    if (status.registered) return { kind: 'settled' };
    return { kind: 'ask', suggested: status.label };
  } catch (error: unknown) {
    // A locked keychain lands here. Asking anyway would mint a token this
    // machine then cannot store, leaving a dead row in the Machines list.
    return { kind: 'failed', reason: describe(error) };
  }
}

/**
 * Claim this computer under a chosen name.
 *
 * The name is required rather than defaulted, so that no code path can register
 * a machine without somebody having decided what it is called.
 */
export async function registerThisMachine(
  chosenLabel: string,
  host: HostBridge | null = getHost(),
  fetchImpl: typeof fetch = fetch,
): Promise<RegistrationOutcome> {
  if (!host) return { kind: 'not-hosted' };

  const label = chosenLabel.trim();
  if (label.length === 0) {
    return { kind: 'failed', reason: 'a machine needs a name' };
  }

  let token: string;
  try {
    const response = await fetchImpl('/api/host/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
      credentials: 'same-origin',
    });

    if (response.status === 401 || response.status === 403) {
      return { kind: 'refused', reason: await reasonFrom(response) };
    }
    if (!response.ok) {
      return { kind: 'failed', reason: await reasonFrom(response) };
    }

    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      return { kind: 'failed', reason: 'the office issued no token' };
    }
    token = body.token;
  } catch (error: unknown) {
    return { kind: 'failed', reason: describe(error) };
  }

  try {
    await host.rememberHostToken(token, label);
  } catch (error: unknown) {
    // The token exists in the office but not on this machine. Saying so is
    // better than pretending it worked: the row is visible in Machines and
    // somebody may wonder why nothing boots.
    return { kind: 'failed', reason: describe(error) };
  }

  return { kind: 'registered', label };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'something went wrong';
}

/**
 * Names this person has already given machines, for the prompt to offer.
 *
 * Best effort: an empty list is a worse prompt, not a broken one, so a failure
 * here must not stop somebody naming their computer.
 */
export async function existingMachineNames(
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetchImpl('/api/host/register', {
      credentials: 'same-origin',
    });
    if (!response.ok) return [];
    const body = (await response.json()) as { machines?: unknown };
    return Array.isArray(body.machines)
      ? body.machines.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}
