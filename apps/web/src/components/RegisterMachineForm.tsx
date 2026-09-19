'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { registerThisMachine } from '@/lib/machine';

/**
 * Name this computer and keep the token the office issues.
 *
 * Shared by the first-run banner, the fleet controls, and the Machines
 * list: those are three doors into the same action, and a second copy of
 * the form would drift. The caller decides the chrome; this is the name
 * field, the existing-names hint, and the claim.
 */
export function RegisterMachineForm({
  suggested,
  existing,
  onRegistered,
}: {
  suggested: string;
  existing: string[];
  onRegistered?: () => void;
}) {
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setName(suggested);
  }, [suggested]);

  const trimmed = name.trim();
  const adopting = existing.includes(trimmed);

  async function claim() {
    setBusy(true);
    setProblem(null);
    const outcome = await registerThisMachine(trimmed);
    setBusy(false);

    if (outcome.kind === 'registered') {
      onRegistered?.();
      window.location.reload();
      return;
    }
    if (outcome.kind === 'not-hosted') return;
    setProblem(outcome.reason);
  }

  return (
    <div>
      <div className="mt-3 flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Machine name"
          placeholder={suggested}
          disabled={busy}
        />
        <Button onClick={() => void claim()} disabled={busy || trimmed.length === 0}>
          {busy ? 'Saving…' : 'Use this name'}
        </Button>
      </div>

      {adopting ? (
        <p className="text-muted-foreground mt-2 text-xs">
          You already have a machine called <strong>{trimmed}</strong>. Using
          that name moves it into this app, and the agents assigned to it keep
          working.
        </p>
      ) : existing.length > 0 ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Already registered: {existing.join(', ')}. Reuse one of those names
          if this is the same computer.
        </p>
      ) : null}

      {problem ? <p className="mt-2 text-xs text-red-600">{problem}</p> : null}
    </div>
  );
}
