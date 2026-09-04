'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/settings', label: 'Office', exact: true },
  { href: '/settings/profile', label: 'Profile', exact: false },
  { href: '/settings/agents', label: 'Agents', exact: false },
  { href: '/settings/channels', label: 'Channels', exact: false },
  { href: '/settings/guests', label: 'Guests', exact: false },
] as const;

/** Tab bar for the settings shell. Client-side only to know what's current. */
export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 border-b">
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              active
                ? 'border-foreground font-medium'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
