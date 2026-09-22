'use client';

import { useEffect, useState } from 'react';

import { useHost } from './use-host';
import { decideOffer, type UpdateOffer } from './update';

/**
 * Whether this machine should be told about a new version, and how loudly.
 *
 * Asks the host once, when the screen it is on mounts. There is no polling: a
 * session that outlives a release is rare, and an app that discovers an update
 * halfway through a conversation and interrupts to say so is worse than one
 * that mentions it next launch.
 *
 * In a browser there is no host, so there is nothing to offer and this stays
 * `{ kind: 'none' }` forever — which is right. A tab cannot install anything,
 * and its version is whatever the server it is talking to is running.
 */
export function useUpdateOffer(): {
  offer: UpdateOffer;
  /** Stop offering this version: remembered by the host, not just by the page. */
  dismiss: () => Promise<void>;
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
      const version = offer.update.version;
      // Remembered first, shown second. If the host cannot write the
      // preference, the honest outcome is that the question comes back — not a
      // page that looks settled and asks again next launch anyway.
      await host?.dismissUpdate(version).catch(() => {});
      setOffer({ kind: 'badge', update: offer.update });
    },
  };
}
