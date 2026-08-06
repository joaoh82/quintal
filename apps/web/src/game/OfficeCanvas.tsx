'use client';

import dynamic from 'next/dynamic';

/**
 * `ssr: false` is only allowed inside a Client Component, which is why this
 * wrapper exists between the (server-rendered, auth-protected) /office page and
 * the game itself. Phaser reaches for `window` on import — there is nothing to
 * render on the server.
 */
const OfficeGame = dynamic(() => import('./OfficeGame'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center rounded-xl border bg-[#14141c] text-sm text-white/50">
      Opening the office…
    </div>
  ),
});

export function OfficeCanvas() {
  return <OfficeGame />;
}
