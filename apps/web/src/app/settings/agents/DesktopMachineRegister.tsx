'use client';

import { useEffect, useState } from 'react';

import { RegisterMachineForm } from '@/components/RegisterMachineForm';
import { knownMachines, machineNaming, type KnownMachine } from '@/lib/machine';
import { useHost } from '@/lib/use-host';

/**
 * The desktop path into registering this computer, on the Machines list.
 *
 * The form below this one mints a token for `quintal-acp login` — a copy-paste
 * for a machine that is not this app. In the app, that ritual leaves the
 * token in the office and not in the keychain, so Start still fails. This
 * is the button that actually registers *this* machine.
 */
export function DesktopMachineRegister() {
  const { host, ready } = useHost();
  const [suggested, setSuggested] = useState<string | null>(null);
  const [knownAs, setKnownAs] = useState<string | null>(null);
  const [known, setKnown] = useState<KnownMachine[]>([]);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void machineNaming().then(async (prompt) => {
      if (cancelled || prompt.kind !== 'ask') return;
      setSuggested(prompt.suggested);
      setKnownAs(prompt.knownAs);
      const machines = await knownMachines();
      if (!cancelled) setKnown(machines);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (!ready || !host || suggested === null) return null;

  return (
    <div className="mt-3 rounded-md border p-3">
      <h3 className="text-xs font-semibold">Register this computer</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        {knownAs === null
          ? `This office does not know this machine yet. Name it to run agents
             here. Each office keeps its own registration, so a token from
             another office will not work.`
          : `This office no longer recognises this machine's registration.
             Register under the same name to take it back — the agents assigned
             to it keep working.`}
      </p>
      <RegisterMachineForm
        suggested={suggested}
        known={known}
        knownAs={knownAs}
      />
    </div>
  );
}