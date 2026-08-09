import { ensurePersonalWorkspace, getDb } from '@quintal/shared/db';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { auth } from '@/lib/auth';

import { SettingsTabs } from './SettingsTabs';

export const dynamic = 'force-dynamic';

/**
 * The settings shell.
 *
 * Everything configurable lives under one roof with one nav, so the answer to
 * "where do I change X" is always the same place — rather than a URL you have
 * to be told about.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const workspace = await ensurePersonalWorkspace(getDb(), {
    userId: session.user.id,
    name: session.user.name,
    pubkey: session.user.pubkey,
  });

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-xs">
          {workspace.name} · {session.user.name}
        </p>
        <Link
          href="/office"
          className="ml-auto rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
        >
          ← Back to the office
        </Link>
      </header>

      <SettingsTabs />

      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
