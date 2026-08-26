import { normaliseHostReport } from '@quintal/shared';
import {
  ensurePersonalWorkspace,
  getDb,
  listHostTokens,
  registerMachineForUser,
} from '@quintal/shared/db';
import { headers } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Register the machine the caller is signed in from.
 *
 * This is the desktop app's replacement for "register a machine, copy the
 * token, paste it into a terminal". The app is already signed in with a key in
 * the OS keychain, so it can just ask — and the session cookie proves the same
 * thing the pasted token was there to prove.
 *
 * Authenticated by session rather than by host token, which is the whole point:
 * a host token is what you get *out* of this, not what you need to call it.
 *
 * ## Why guests are refused
 *
 * A machine is somewhere the office may start child processes. "Is signed in"
 * and "this computer belongs to me" are different claims, and a guest link is
 * explicitly the first without the second — it is a session someone was handed,
 * often on somebody else's computer. Letting a guest register the desktop app's
 * host would turn a link that was meant to show somebody a room into a foothold
 * for running processes on the machine displaying it. So the smooth path is for
 * people who hold the office's own key; a guest keeps the old one, or none.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }

  if (session.session.isGuest) {
    return NextResponse.json(
      {
        error:
          'a guest session cannot register a machine. Sign in with your own key to run agents here.',
      },
      { status: 403 },
    );
  }

  const body: unknown = await request.json().catch(() => null);

  // Reuse the report normaliser rather than trusting `label` off the wire: it
  // already strips the control characters and bidi marks that would otherwise
  // be drawn into the Machines list, and clamps the length.
  const report = normaliseHostReport({
    label: (body as { label?: unknown } | null)?.label ?? '',
  });
  if (!report) {
    return NextResponse.json(
      { error: 'a machine needs a name' },
      { status: 400 },
    );
  }

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const machine = await registerMachineForUser(db, {
    workspaceId: workspace.id,
    ownerUserId: session.user.id,
    label: report.label,
  });

  // The plaintext exists exactly here and never again.
  return NextResponse.json({
    token: machine.token,
    label: machine.label,
    workspaceId: workspace.id,
  });
}

/**
 * The machines this person has already registered.
 *
 * Only names, and only their own. The prompt uses them so that naming this
 * computer after one it already has is a visible choice rather than an accident
 * — reusing a name replaces that machine's token, which is exactly how you move
 * a machine into the app without orphaning the agents pinned to it.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: 'sign in first' }, { status: 401 });
  }
  if (session.session.isGuest) {
    return NextResponse.json({ machines: [] });
  }

  const db = getDb();
  const workspace = await ensurePersonalWorkspace(db, {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  const machines = (await listHostTokens(db, workspace.id))
    .filter((row) => row.revokedAt === null && row.ownerUserId === session.user.id)
    .map((row) => row.label);

  return NextResponse.json({ machines: [...new Set(machines)] });
}
