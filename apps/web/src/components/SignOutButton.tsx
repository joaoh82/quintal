'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { signOut } from '@/lib/auth-client';

/**
 * End the session.
 *
 * Deliberately does *not* forget a key saved to this browser. The saved key may
 * be the only copy in existence — we never had it and cannot reissue it — so
 * signing out must not be able to destroy an identity. Forgetting a key is a
 * separate, explicit act, offered on the sign-in page where the consequence can
 * be spelled out.
 *
 * The cost is that on a shared machine "signed out" still leaves a credential
 * behind. That is the honest trade for a browser-held key, and the reason the
 * save checkbox says what it says.
 */
export function SignOutButton({ className = '' }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signOut();
          // `replace`, not `push`: the office is not somewhere Back should
          // return you to once the session behind it is gone.
          router.replace('/login');
          router.refresh();
        } finally {
          // Without this a failed sign-out leaves the button disabled forever,
          // so the one control for getting out of a session is the thing that
          // breaks when the session misbehaves.
          setBusy(false);
        }
      }}
      className={`hover:bg-accent rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${className}`}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
