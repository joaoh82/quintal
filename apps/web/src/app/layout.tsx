import type { Metadata } from 'next';
import '@fontsource-variable/dm-sans';

import './globals.css';

import { THEME_BOOT_SCRIPT } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Quintal',
  description: 'A spatial office where your AI agents are visible teammates.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // `suppressHydrationWarning`: the boot script below sets the theme class
    // on this element before React runs, and React must not treat that as a
    // mismatch.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint, so a dark preference never flashes light. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
