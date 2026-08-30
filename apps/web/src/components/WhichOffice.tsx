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
  const [shown, setShown] = useState<{ name: string | null; where: string } | null>(null);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    void (async () => {
      // What the office calls itself wins. It is the one answer everybody
      // arriving here sees the same, which is the point of having it.
      const named = await fetch('/api/office', { credentials: 'same-origin' })
        .then((response) => (response.ok ? (response.json() as Promise<{ name?: string }>) : null))
        .then((body) => (typeof body?.name === 'string' && body.name.length > 0 ? body.name : null))
        .catch(() => null);

      // Then the name you gave it in the picker, which only the host knows —
      // useful for telling two of your own deployments apart.
      const labelled = named
        ? null
        : await host
            ?.listOffices()
            .then((listed) => {
              const active = listed.offices.find((office) => office.url === listed.active);
              return active?.label ?? null;
            })
            .catch(() => null);

      if (cancelled) return;
      setShown({ name: named ?? labelled ?? null, where: window.location.host });
    })();

    return () => {
      cancelled = true;
    };
  }, [host, ready]);

  if (shown === null) return null;

  return (
    <p className={className ?? 'text-muted-foreground text-center text-xs'}>
      {shown.name ? <span className="mr-1.5 font-medium">{shown.name}</span> : null}
      {/*
        The address is shown even when the office has a name. Two deployments
        can be called the same thing, and "am I on staging or production" is
        exactly the question this is here to answer.
      */}
      <span className="bg-muted rounded px-1.5 py-0.5 font-mono">{shown.where}</span>
    </p>
  );
}
