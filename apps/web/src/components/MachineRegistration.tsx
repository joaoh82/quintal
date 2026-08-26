'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  existingMachineNames,
  machineNaming,
  registerThisMachine,
} from '@/lib/machine';

/**
 * Name this computer, once.
 *
 * Shown only in the desktop app, only when this machine holds no token yet, and
 * never again once it does. In a browser it costs one `undefined` check.
 *
 * It asks rather than assuming, because the hostname is a good default and a bad
 * decision: agents are pinned to a machine *by label*, so quietly registering
 * `Joaos-MacBook-Pro-2` beside a `Laptop` somebody had already set up leaves
 * every agent assigned to the old name with nowhere to run. Offering the names
 * already in use turns that from a trap into the way you move a machine into the
 * app — reusing one takes it over.
 *
 * Dismissable, and dismissed for this page only: nagging somebody who opened the
 * app to do something else is how a one-time question becomes a papercut. It
 * comes back next launch, because an unregistered machine really cannot run
 * anything and silence would be a worse answer.
 */
export function MachineRegistration() {
  const [suggested, setSuggested] = useState<string | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void machineNaming().then(async (prompt) => {
      if (cancelled || prompt.kind !== 'ask') return;
      setSuggested(prompt.suggested);
      setName(prompt.suggested);
      const names = await existingMachineNames();
      if (!cancelled) setExisting(names);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (suggested === null || dismissed) return null;

  const trimmed = name.trim();
  const adopting = existing.includes(trimmed);

  async function claim() {
    setBusy(true);
    setProblem(null);
    const outcome = await registerThisMachine(trimmed);
    setBusy(false);

    if (outcome.kind === 'registered') {
      setDismissed(true);
      // The settings page reads machines on the server, so it has to be asked
      // again rather than told.
      window.location.reload();
      return;
    }
    if (outcome.kind === 'not-hosted') return;
    setProblem(outcome.reason);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
      <section className="bg-background w-full max-w-md rounded-lg border p-4 shadow-lg">
        <h2 className="text-sm font-semibold">Name this computer</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Quintal will run agents here. The name is how you tell your machines
          apart, and what you assign an agent to.
        </p>

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

        <button
          type="button"
          className="text-muted-foreground mt-3 text-xs underline"
          onClick={() => setDismissed(true)}
        >
          Not now
        </button>
      </section>
    </div>
  );
}
