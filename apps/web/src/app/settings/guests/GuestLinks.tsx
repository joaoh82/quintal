'use client';

import type { InviteLink } from '@quintal/shared/db';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { createGuestLinkAction, revokeGuestLinkAction } from './actions';

interface GuestLinksProps {
  links: InviteLink[];
}

/**
 * Absolute and UTC, not relative: an expiry is a deadline somebody plans
 * around, and "in 3 days" is the wrong shape for that. It is also identical on
 * the server and the client, so it cannot produce a hydration mismatch.
 */
function expiryLabel(at: Date): string {
  return at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function statusOf(link: InviteLink): string {
  if (link.revokedAt) return 'revoked';
  if (link.usedCount >= link.maxUses) return 'used up';
  if (link.expiresAt.getTime() <= Date.now()) return 'expired';
  return `${link.maxUses - link.usedCount} left`;
}

export function GuestLinks({ links }: GuestLinksProps) {
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onCreate(formData: FormData) {
    setBusy(true);
    setError('');
    setCreated(null);
    const result = await createGuestLinkAction(formData);
    if (result.ok) setCreated(result.url);
    else setError(result.error);
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <form action={onCreate} className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Valid for (hours)</span>
            <Input
              name="hours"
              type="number"
              min={1}
              max={720}
              defaultValue={72}
              className="w-28"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Guests allowed</span>
            <Input
              name="maxUses"
              type="number"
              min={1}
              max={100}
              defaultValue={1}
              className="w-28"
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create guest link'}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Anyone holding this link can walk into your office as a guest, without
          an identity of their own. Keep the limits tight — a link gets
          forwarded.
        </p>
      </form>

      {created ? (
        <div className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <p className="text-sm font-medium">
            Copy this now — it is not shown again.
          </p>
          <p className="font-mono text-xs break-all">{created}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard?.writeText(created)}
          >
            Copy link
          </Button>
        </div>
      ) : null}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div>
        <h2 className="mb-2 text-sm font-medium">Links you have made</h2>
        {links.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-sm"
              >
                <span className="font-mono text-xs">
                  {link.usedCount}/{link.maxUses} used
                </span>
                <span className="text-muted-foreground text-xs">
                  {statusOf(link)} · expires {expiryLabel(link.expiresAt)}
                </span>
                {link.revokedAt === null ? (
                  <form action={revokeGuestLinkAction} className="ml-auto">
                    <input type="hidden" name="linkId" value={link.id} />
                    <Button type="submit" variant="outline" size="sm">
                      Revoke
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
