import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Quintal',
  description: 'A spatial office where your AI agents are visible teammates.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
