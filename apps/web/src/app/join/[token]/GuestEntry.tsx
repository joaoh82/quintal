'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { DISPLAY_NAME_MAX_LENGTH } from '@quintal/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createIdentity, signIn } from '@/lib/keys';

/**
 * Walking in as a guest.
 *
 * The keypair is generated here, used once, and never written anywhere — not
 * to localStorage, and on the server only as the `pubkey` of the row that has
 * to exist for a guest to be a person in the room. Close the tab and the key
 * is gone; that is the intended lifetime of a visit.
 *
 * The name is asked for here because it cannot be changed later: a guest
 * keeps the name they arrived with. Left blank, they are shown as their key,
 * which nobody can type — so the question is worth the one line it costs.
 */
export function GuestEntry({ token }: { token: string }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onEnter() {
    setBusy(true);
    setError('');
    try {
      await signIn(createIdentity(), { inviteToken: token, name: name.trim() });
      router.push('/office');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not join.');
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onEnter();
      }}
    >
      <label className="block text-sm">
        <span className="mb-1 block font-medium">What should people call you?</span>
        <Input
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Leave blank to be shown as your key"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          autoComplete="nickname"
          autoFocus
          disabled={busy}
        />
        <span className="text-muted-foreground mt-1 block text-xs">
          It stays for the visit — guests cannot rename themselves later.
        </span>
      </label>
      <Button type="submit" className="w-full" disabled={busy}>
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
    </form>
  );
}
