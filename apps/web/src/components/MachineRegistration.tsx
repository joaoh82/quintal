'use client';

import { useEffect, useState } from 'react';

import { RegisterMachineForm } from '@/components/RegisterMachineForm';
import { knownMachines, machineNaming, type KnownMachine } from '@/lib/machine';

/**
 * Name this computer, once — or take it back.
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
 * The same prompt is the recovery path, which is why it says different words
 * when the app remembers a registration this office no longer honours. A
 * rejected token is not always somebody revoking a machine on purpose — a dev
 * server pointed at a fresh database rejects a perfectly good one — and the
 * version of this that asked "name this computer", with the hostname already
 * in the field, turned one unlucky 401 into a second machine and four agents
 * with nowhere to run.
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
  const [knownAs, setKnownAs] = useState<string | null>(null);
  const [known, setKnown] = useState<KnownMachine[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const prompt = await machineNaming();
      if (cancelled || prompt.kind !== 'ask') return;
      setSuggested(prompt.suggested);
      setKnownAs(prompt.knownAs);
      const machines = await knownMachines();
      if (!cancelled) setKnown(machines);
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
        <h2 className="text-sm font-semibold">
          {knownAs === null ? 'Name this computer' : 'Register this computer again'}
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {knownAs === null ? (
            <>
              Quintal will run agents here. The name is how you tell your
              machines apart, and what you assign an agent to. Each office needs
              its own registration — a token from another office will not work
              here.
            </>
          ) : (
            <>
              This office stopped recognising this machine&rsquo;s registration.
              Nothing has been lost: register under the same name and the agents
              assigned to it carry on. Renaming it here creates a second machine
              and leaves those agents with nowhere to run.
            </>
          )}
        </p>

        <RegisterMachineForm
          suggested={suggested}
          known={known}
          knownAs={knownAs}
        />

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
