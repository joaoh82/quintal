'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getHost, isHostError, type Backup } from '@/lib/host';

/**
 * Backing up the key this computer holds.
 *
 * App-only, and it says so in a browser rather than hiding: somebody reading
 * the settings page on the web should learn that this exists and where to get
 * it, not find a gap where a control ought to be.
 *
 * The shape of this card is set by one fact — nobody can reissue this key. So
 * the export is shown once with its passphrase, wiping is refused until the
 * person says they have stored it, and every button that destroys something
 * asks first.
 */
export function KeyBackup() {
  const host = getHost();
  const [backup, setBackup] = useState<Backup | null>(null);
  const [stored, setStored] = useState(false);
  const [canWipe, setCanWipe] = useState(false);
  const [importing, setImporting] = useState({ secret: '', passphrase: '' });
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!host) return;
    void host.canWipe().then(setCanWipe).catch(() => setCanWipe(false));
  }, [host]);

  if (!host) {
    return (
      <div className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-medium">Key backup</h2>
        <p className="text-muted-foreground text-xs">
          Backing up your key is done by the desktop app, which is what holds it
          — a browser has nothing to back up. If you signed in here by pasting an
          nsec, that nsec <em>is</em> your backup; keep it somewhere safe.
        </p>
      </div>
    );
  }

  function fail(cause: unknown, fallback: string) {
    if (isHostError(cause)) {
      const messages: Partial<Record<typeof cause.code, string>> = {
        locked: 'Your keychain is locked. Unlock it and try again.',
        bad_passphrase: 'That passphrase does not open this backup.',
        not_a_backup: 'That is not a backup or a key we recognise.',
        cost_too_high: 'That backup asks for more memory than we will spend on it.',
        no_backup: 'Export a backup and confirm you have stored it first.',
      };
      setError(messages[cause.code] ?? cause.message);
    } else {
      setError(cause instanceof Error ? cause.message : fallback);
    }
    setBusy(false);
  }

  async function onExport() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      setBackup(await host!.exportBackup());
      setStored(false);
      setBusy(false);
    } catch (cause: unknown) {
      fail(cause, 'Could not make a backup.');
    }
  }

  async function onConfirmStored() {
    setBusy(true);
    setError('');
    try {
      await host!.confirmBackup();
      setCanWipe(true);
      setBackup(null);
      setNote('Backup recorded. You can restore this identity with those two things.');
      setBusy(false);
    } catch (cause: unknown) {
      fail(cause, 'Could not record the backup.');
    }
  }

  async function onImport() {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const npub = await host!.importIdentity(
        importing.secret,
        importing.passphrase || undefined,
      );
      setNote(`Now signed in as ${npub.slice(0, 13)}…${npub.slice(-6)}. Reload to see it everywhere.`);
      setImporting({ secret: '', passphrase: '' });
      setBusy(false);
    } catch (cause: unknown) {
      fail(cause, 'Could not import that.');
    }
  }

  async function onWipe() {
    setBusy(true);
    setError('');
    try {
      await host!.wipeIdentity();
      window.location.href = '/login';
    } catch (cause: unknown) {
      fail(cause, 'Could not wipe.');
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h2 className="text-sm font-medium">Key backup</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          This computer holds your key in its keychain. Nobody can reissue it —
          not us, not anyone — so a backup is the only way this identity survives
          a lost machine.
        </p>
      </div>

      {backup ? (
        <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-sm font-medium">
            Write both of these down. They are shown once.
          </p>
          <div>
            <p className="text-muted-foreground text-xs">Backup</p>
            <p className="font-mono text-xs break-all">{backup.blob}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">Passphrase</p>
            <p className="font-mono text-sm break-all">{backup.passphrase}</p>
          </div>
          <p className="text-muted-foreground text-xs">
            The backup is useless without the passphrase. Storing them in the
            same place gives up most of the point.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={stored}
              onChange={(event) => setStored(event.target.checked)}
            />
            <span>I have stored both somewhere I will still have them later.</span>
          </label>
          <Button size="sm" disabled={!stored || busy} onClick={onConfirmStored}>
            Done
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={onExport}>
          {busy ? 'Working…' : 'Export a backup'}
        </Button>
      )}

      <details className="border-t pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          Restore from a backup
        </summary>
        <div className="mt-3 space-y-2">
          <Input
            placeholder="ncryptsec1… or nsec1…"
            value={importing.secret}
            spellCheck={false}
            onChange={(event) =>
              setImporting((prev) => ({ ...prev, secret: event.target.value }))
            }
          />
          <Input
            type="password"
            placeholder="Passphrase (only for an ncryptsec)"
            value={importing.passphrase}
            onChange={(event) =>
              setImporting((prev) => ({ ...prev, passphrase: event.target.value }))
            }
          />
          <p className="text-muted-foreground text-xs">
            This replaces the key on this computer. Back the current one up first
            if you still want it.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || importing.secret.trim().length === 0}
            onClick={onImport}
          >
            Restore
          </Button>
        </div>
      </details>

      <div className="border-t pt-3">
        {confirmWipe ? (
          <div className="space-y-2">
            <p className="text-destructive text-sm font-medium">
              Forget this identity on this computer?
            </p>
            <p className="text-muted-foreground text-xs">
              Without the backup and its passphrase, this identity and its office
              are gone. There is no reset.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={onWipe}>
                Wipe it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmWipe(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canWipe || busy}
              onClick={() => setConfirmWipe(true)}
            >
              Sign out &amp; wipe this computer
            </Button>
            {canWipe ? null : (
              <p className="text-muted-foreground mt-1 text-xs">
                Available once you have exported a backup and confirmed you
                stored it.
              </p>
            )}
          </>
        )}
      </div>

      {note ? <p className="text-sm text-emerald-600">{note}</p> : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
