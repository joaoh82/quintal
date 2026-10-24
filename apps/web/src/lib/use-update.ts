'use client';

import { useEffect, useState } from 'react';

import { useHost } from './use-host';
import { decideOffer, type UpdateOffer } from './update';

/**
 * Whether this machine should be told about a new version, and how loudly.
 *
 * Asks the host once, when the screen it is on mounts. There is no polling: an
 * app that discovers an update halfway through a conversation and interrupts
 * to say so is worse than one that mentions it next launch. Somebody who wants
 * to know sooner asks — `check`, behind **Check for updates** in settings.
 *
 * In a browser there is no host, so there is nothing to offer and this stays
 * `{ kind: 'none' }` forever — which is right. A tab cannot install anything,
 * and its version is whatever the server it is talking to is running.
 */
export function useUpdateOffer(): {
  offer: UpdateOffer;
  /** Stop offering this version: remembered by the host, not just by the page. */
  dismiss: () => Promise<void>;
  /** Whether there is a host to ask — false in a browser, and until we know. */
  canCheck: boolean;
  /**
   * Ask the host again, now, and show what it says. Resolves with the new
   * offer; rejects when the host could not ask, so the caller can say so.
   */
  check: () => Promise<UpdateOffer>;
} {
  const { host, ready } = useHost();
  const [offer, setOffer] = useState<UpdateOffer>({ kind: 'none' });

  useEffect(() => {
    if (!ready || !host) return;
    let live = true;

    void (async () => {
      // Both questions together: what is available, and what was already
      // turned down. Asking them in sequence would let a slow network decide
      // whether somebody gets interrupted by a version they declined weeks ago.
      const [available, state] = await Promise.all([
        host.checkForUpdate().catch(() => null),
        host.updateState().catch(() => ({ dismissed: null })),
      ]);
      if (live) setOffer(decideOffer(available, state.dismissed));
    })();

    return () => {
      live = false;
    };
  }, [host, ready]);

  return {
    offer,
    dismiss: async () => {
      if (offer.kind === 'none') return;
      // Remembered first, shown second, and **only** if the remembering
      // worked. Swallowing the failure here would leave the page looking
      // settled for one session and asking again next launch, which is the
      // exact behaviour "Later" is supposed to rule out. A failure propagates
      // so the caller can leave the question open.
      await host?.dismissUpdate();
      setOffer({ kind: 'badge', update: offer.update });
    },
    canCheck: ready && host !== null,
    check: async () => {
      if (!host) return { kind: 'none' };
      const [available, state] = await Promise.all([
        host.recheckForUpdate(),
        host.updateState().catch(() => ({ dismissed: null })),
      ]);
      const next = decideOffer(available, state.dismissed);
      setOffer(next);
      return next;
    },
  };
}
