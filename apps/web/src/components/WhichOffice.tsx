'use client';

import { useEffect, useState } from 'react';

import { useHost } from '@/lib/use-host';

/**
 * Which office this is.
 *
 * Obvious in a browser — the address bar says so. The app has no address bar,
 * so once you have more than one office there is nothing on the sign-in screen
 * telling you which of them you are signing into, and every office looks
 * identical until you are inside it. Switching to the wrong one and only
 * finding out after you have signed in is a bad way to learn.
 *
 * Prefers the name you gave the office in the picker, because "work" means more
 * than `localhost:3100`. Falls back to the host, which is what the picker
 * defaults its labels to anyway.
 *
 * Renders nothing until it knows: an office is not something to guess at, and a
 * flash of the wrong name would be worse than a moment of none.
 */
export function WhichOffice({ className }: { className?: string }) {
  const { host, ready } = useHost();
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;

    // The host is asked first: it knows the label somebody chose, which the
    // page cannot see.
    if (!host) {
      setName(window.location.host);
      return;
    }

    let cancelled = false;
    void host
      .listOffices()
      .then((listed) => {
        if (cancelled) return;
        const active = listed.offices.find((office) => office.url === listed.active);
        setName(active?.label ?? window.location.host);
      })
      .catch(() => {
        if (!cancelled) setName(window.location.host);
      });

    return () => {
      cancelled = true;
    };
  }, [host, ready]);

  if (name === null) return null;

  return (
    <p className={className ?? 'text-muted-foreground text-center text-xs'}>
      <span className="bg-muted rounded px-1.5 py-0.5 font-mono">{name}</span>
    </p>
  );
}
