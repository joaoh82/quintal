'use client';

import { useEffect, useState } from 'react';

import { getHost, type HostBridge } from './host';

/**
 * The desktop bridge, in a way that survives hydration.
 *
 * `getHost()` cannot be called while rendering. It answers `null` on the server
 * — there is no `window` there — and the bridge in the app, so a component that
 * branches on it renders one tree on the server and a different one on the
 * client. React calls that a hydration mismatch, throws away the server HTML,
 * and re-renders; the visible symptom is an error overlay on a page that looks
 * fine, which is a bad way to learn about it.
 *
 * So the first client render deliberately agrees with the server — `ready` is
 * false, `host` is null — and the real answer arrives in an effect, which runs
 * only on the client and only after hydration has matched.
 *
 * `ready` matters as much as `host`. Without it "we have not looked yet" is
 * indistinguishable from "there is no host", and every hosted surface would
 * flash its browser-only message before correcting itself.
 */
export function useHost(): { host: HostBridge | null; ready: boolean } {
  const [state, setState] = useState<{ host: HostBridge | null; ready: boolean }>({
    host: null,
    ready: false,
  });

  useEffect(() => {
    setState({ host: getHost(), ready: true });
  }, []);

  return state;
}
