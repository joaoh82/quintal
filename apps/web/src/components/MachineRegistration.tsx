'use client';

import { useEffect, useState } from 'react';

import { RegisterMachineForm } from '@/components/RegisterMachineForm';
import { existingMachineNames, machineNaming } from '@/lib/machine';

/**
 * Name this computer, once.
 *
 * Shown only in the desktop app, only when this machine holds no token yet for
 * *this* office, and never again once it does. In a browser it costs one
 * `undefined` check.
 *
 * It asks rather than assuming, because the hostname is a good default and a
 * bad decision: agents are pinned to a machine *by label*, so quietly
 * registering `Joaos-MacBook-Pro-2` beside a `Laptop` somebody had already
 * set up leaves every agent assigned to the old name with nowhere to run.
 * Offering the names already in use turns that from a trap into the way you
 * move a machine into the app — reusing one takes it over.
 *
 * Dismissable, and dismissed for this page only: nagging somebody who opened
 * the app to do something else is how a one-time question becomes a papercut.
 * It comes back next launch, because an unregistered machine really cannot
 * run anything and silence would be a worse answer.
 *
 * Polls, because a token this office just rejected is forgotten as the
 * fleet starts, and a banner that asked once at mount would still think
 * this machine was registered.
 */
const POLL_MS = 2000;

export function MachineRegistration() {
  const [suggested, setSuggested] = useState<string | null>(null);
  const [existing, setExisting] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const prompt = await machineNaming();
      if (cancelled || prompt.kind !== 'ask') return;
      setSuggested(prompt.suggested);
      const names = await existingMachineNames();
      if (!cancelled) setExisting(names);
    }

    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (suggested === null || dismissed) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
      <section className="bg-background w-full max-w-md rounded-lg border p-4 shadow-lg">
        <h2 className="text-sm font-semibold">Name this computer</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Quintal will run agents here. The name is how you tell your machines
          apart, and what you assign an agent to. Each office needs its own
          registration — a token from another office will not work here.
        </p>

        <RegisterMachineForm suggested={suggested} existing={existing} />

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
