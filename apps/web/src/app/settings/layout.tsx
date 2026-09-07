import { displayName } from '@quintal/shared';
import { getDb } from '@quintal/shared/db';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { MachineRegistration } from '@/components/MachineRegistration';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Wordmark } from '@/components/Wordmark';

import { SettingsTabs } from './SettingsTabs';
import { requestSession, requestOffice } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The settings shell.
 *
 * Everything configurable lives under one roof with one nav, so the answer to
 * "where do I change X" is always the same place — rather than a URL you have
 * to be told about.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requestSession();
  if (!session) redirect('/login');

  const here = await requestOffice();
  if (!here) redirect('/login');

  return (
    <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Wordmark href="/office" size="sm" />
        <h1 className="text-lg font-medium tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-xs">
          {here.workspace.name}
          {here.role === 'guest' ? ' (visiting)' : ''} · {displayName(session.user)}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle compact />
          <Link
            href="/office"
            className="hover:bg-accent rounded-md border px-2.5 py-1 text-xs"
          >
            ← Back to the office
          </Link>
          <SignOutButton />
        </div>
      </header>

      <SettingsTabs />

      <div className="min-h-0 flex-1">{children}</div>

      <MachineRegistration />
    </div>
  );
}
