'use client';

import {
  DISPLAY_NAME_MAX_LENGTH,
  PROFILE_DESCRIPTION_MAX_LENGTH,
  truncateNpub,
} from '@quintal/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { KeyBackup } from './KeyBackup';
import { resetDisplayNameAction, saveProfileAction } from './actions';

interface ProfileFormProps {
  name: string;
  description: string;
  npub: string;
  pubkey: string;
  isGuest: boolean;
}

export function ProfileForm({
  name,
  description,
  npub,
  pubkey,
  isGuest,
}: ProfileFormProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  async function onSave(formData: FormData) {
    setBusy(true);
    setError('');
    const result = await saveProfileAction(formData);
    if (result.ok) {
      // Reload rather than just saying "Saved": the server normalises what it
      // stored, so leaving the typed value in the field would show a name that
      // is not the one anybody else sees.
      window.location.reload();
      return;
    }
    setError(result.error);
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <form action={onSave} className="space-y-4 rounded-lg border p-4">
        <div className="space-y-1">
          <label htmlFor="name" className="text-sm font-medium">
            Display name
          </label>
          <Input
            id="name"
            name="name"
            defaultValue={name}
            // An account with no name of its own leaves this empty, so the
            // placeholder shows what people currently see instead. Derived
            // from a prop, not from `window` — the same field once read the
            // host off the browser and mismatched on hydration.
            placeholder={truncateNpub(npub)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            disabled={busy || isGuest}
            required
          />
          <p className="text-muted-foreground text-xs">
            What people see above your avatar and in the roster. Names are not
            unique — your key is what identifies you, and it is shown wherever
            somebody picks you out of a list.
          </p>
        </div>

        <div className="space-y-1">
          <label htmlFor="description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            defaultValue={description}
            maxLength={PROFILE_DESCRIPTION_MAX_LENGTH}
            rows={3}
            disabled={busy || isGuest}
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
          />
          <p className="text-muted-foreground text-xs">
            A line about what you do. Shown on your profile card.
          </p>
        </div>

        {isGuest ? (
          <p className="text-muted-foreground text-sm">
            You&apos;re here as a guest, so your name stays as you arrived. Sign
            in with a key of your own to set one.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                const result = await resetDisplayNameAction();
                if (result.ok) window.location.reload();
                else {
                  setError(result.error);
                  setBusy(false);
                }
              }}
            >
              Reset to my npub
            </Button>
          </div>
        )}

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <div className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Identity</h2>
        <p className="text-muted-foreground text-xs">
          Your public key. This is the part that actually identifies you — a
          display name is only a label, and two people may share one.
        </p>
        <p className="font-mono text-xs break-all">{npub}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(npub);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy npub'}
        </Button>
        <details className="pt-1">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Show hex
          </summary>
          <p className="mt-1 font-mono text-xs break-all">{pubkey}</p>
        </details>
      </div>

      <KeyBackup />
    </div>
  );
}
