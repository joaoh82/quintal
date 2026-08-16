'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { createIdentity, signIn } from '@/lib/keys';

/**
 * Walking in as a guest.
 *
 * The keypair is generated here, used once, and never written anywhere — not
 * to localStorage, and on the server only as the `pubkey` of the row that has
 * to exist for a guest to be a person in the room. Close the tab and the key
 * is gone; that is the intended lifetime of a visit.
 */
export function GuestEntry({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onEnter() {
    setBusy(true);
    setError('');
    try {
      await signIn(createIdentity(), { inviteToken: token });
      router.push('/office');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button className="w-full" onClick={onEnter} disabled={busy}>
        {busy ? 'Joining…' : 'Join as a guest'}
      </Button>
      <p className="text-muted-foreground text-xs">
        You&apos;ll show up with a “Guest” badge so everyone knows you&apos;re
        visiting.
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
