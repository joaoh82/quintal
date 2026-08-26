'use client';

import { useEffect } from 'react';

import { useHost } from '@/lib/use-host';

/**
 * Start this machine's agents when the app opens.
 *
 * The whole promise of the desktop app is that your teammates are *there* when
 * you walk in. Having to visit a settings page and press Start before anybody
 * can be talked to makes them something you administer rather than somebody you
 * work with — and it is a step you would take every single morning.
 *
 * Deliberately quiet and deliberately conditional:
 *
 * - **Only when nothing is running.** Starting is refused if the fleet is
 *   already up, and there is no reason to make the office produce an error to
 *   discover that.
 * - **Only in the app.** A browser cannot start a process, which is exactly why
 *   this component renders nothing there.
 * - **Never noisy.** If it fails — an unregistered machine, no harness on PATH —
 *   the settings page says so properly, with a Start button and a log. An error
 *   on top of the office would interrupt somebody who came here to do something
 *   else.
 *
 * The office is the page's own origin, so the harness always connects to the
 * office the person is actually looking at.
 */
export function AutoStartFleet() {
  const { host } = useHost();

  useEffect(() => {
    if (!host) return;
    let cancelled = false;

    void (async () => {
      try {
        const state = await host.fleetStatus();
        // 'crashed' is left alone on purpose: something already went wrong once,
        // and restarting it silently on every launch would hide that rather than
        // fix it.
        if (cancelled || state.state !== 'stopped') return;
        await host.startFleet();
      } catch {
        // Nothing here is worth interrupting anybody over — see above.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [host]);

  return null;
}
