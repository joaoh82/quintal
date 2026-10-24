'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { getHost, isHostError } from '@/lib/host';
import { useUpdateOffer } from '@/lib/use-update';

/**
 * The new-version offer.
 *
 * Two shapes, one component, because they are two volumes of the same thing
 * and splitting them would let the wording drift. A version nobody has been
 * asked about interrupts, once. A version somebody declined sits in the header
 * as a button and waits, for as long as it takes.
 *
 * `compact` is the quiet one: it never opens itself, which is what makes it
 * safe to put on a settings page somebody opened to do something else. With
 * nothing on offer it is a **Check for updates** button instead, so an app
 * left open for days does not have to be restarted to find a release — and
 * what that finds opens, declined before or not, because it was asked for.
 *
 * Nothing here renders in a browser. `useUpdateOffer` has no host to ask, so
 * the offer stays `none` — a tab cannot replace an application, and pretending
 * otherwise would be a button that lies.
 */
export function UpdateNotice({ compact = false }: { compact?: boolean }) {
  const { offer, dismiss, canCheck, check } = useUpdateOffer();
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<'idle' | 'checking' | 'current' | 'failed'>('idle');
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState('');

  // A version nobody has answered about opens the ask by itself — except in
  // the compact places, which are somebody else's screen.
  useEffect(() => {
    if (offer.kind === 'prompt' && !compact) setOpen(true);
  }, [offer.kind, compact]);

  // The host reports the download through a page hook, the same way the global
  // push-to-talk key arrives (see `ptt.rs`). Defined for the whole life of the
  // component rather than from the moment the install starts: an effect that
  // waited on `installing` could still be pending when the first chunks land,
  // and the bar would jump rather than fill. A screen without this component
  // has no hook at all, and the host's call is a no-op.
  useEffect(() => {
    const hook = (fraction: number | null) => setProgress(fraction);
    (window as unknown as { __quintalUpdateProgress?: typeof hook }).__quintalUpdateProgress =
      hook;
    return () => {
      delete (window as unknown as { __quintalUpdateProgress?: unknown })
        .__quintalUpdateProgress;
    };
  }, []);

  const checkNow = async () => {
    setProblem('');
    setChecked('checking');
    try {
      const found = await check();
      if (found.kind === 'none') {
        setChecked('current');
      } else {
        setChecked('idle');
        setOpen(true);
      }
    } catch (cause) {
      setChecked('failed');
      // Not a `HostError` is, in practice, a host from before this button:
      // it does not have the command, and its one check was at launch.
      setProblem(
        isHostError(cause)
          ? cause.message
          : 'This copy of Quintal cannot check from here. Quit and reopen it to check.',
      );
    }
  };

  if (offer.kind === 'none') {
    if (!compact || !canCheck) return null;
    return (
      <span className="flex items-center gap-2">
        {checked === 'current' ? (
          <span className="text-muted-foreground text-xs" role="status">
            Up to date
          </span>
        ) : checked === 'failed' ? (
          <span className="max-w-64 text-xs text-red-600 dark:text-red-400" role="alert">
            {problem}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void checkNow()}
          disabled={checked === 'checking'}
          className="hover:bg-accent rounded-md border px-2.5 py-1 text-xs disabled:opacity-60"
        >
          {checked === 'checking' ? 'Checking…' : 'Check for updates'}
        </button>
      </span>
    );
  }
  const { update } = offer;

  const install = async () => {
    setProblem('');
    setInstalling(true);
    try {
      // Does not resolve: the host replaces the app and restarts it. Anything
      // written after this runs only because something went wrong.
      await getHost()?.installUpdate();
    } catch (cause) {
      setInstalling(false);
      setProgress(null);
      setProblem(
        isHostError(cause) ? cause.message : 'The update could not be installed.',
      );
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
      >
        Update to {update.version}
      </button>
    );
  }

  return (
    <div className="bg-card fixed right-4 bottom-4 z-50 w-80 rounded-lg border p-4 shadow-lg">
      <p className="text-sm font-medium">Quintal {update.version} is available</p>
      <p className="text-muted-foreground mt-1 text-xs">
        You are running {update.current}.
      </p>

      {update.notes ? (
        <p className="text-muted-foreground mt-2 max-h-24 overflow-y-auto text-xs whitespace-pre-line">
          {update.notes}
        </p>
      ) : null}

      {/*
        The copy cannot replace itself — a .deb apt owns, or an app still being
        run out of its mounted DMG. Saying so is the whole point: the offer is
        real even where the button cannot be.
      */}
      {!update.canInstall ? (
        <>
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            {update.blocked ?? 'This copy cannot update itself.'}
          </p>
          <div className="mt-3 flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </>
      ) : installing ? (
        <div className="mt-3">
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full transition-[width] duration-200"
              // An unknown total is drawn as a full, quiet bar rather than a
              // fake percentage: the download is real either way.
              style={{ width: progress === null ? '100%' : `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Downloading… Quintal will restart on its own.
          </p>
        </div>
      ) : (
        <>
          {problem ? (
            <p className="mt-3 text-xs text-red-600 dark:text-red-400">{problem}</p>
          ) : null}
          <div className="mt-3 flex justify-end gap-2">
            {/*
              "Later" is a real answer, and the host remembers it: this version
              is not asked about again. The offer stays in the header.
            */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Closed only once the host has written it down. If that
                // fails the panel stays up with the reason, because a "Later"
                // that did not persist would ask again next launch and make
                // the answer meaningless.
                void dismiss()
                  .then(() => setOpen(false))
                  .catch((cause: unknown) =>
                    setProblem(
                      isHostError(cause)
                        ? cause.message
                        : 'That could not be saved, so you will be asked again.',
                    ),
                  );
              }}
            >
              Later
            </Button>
            <Button size="sm" onClick={() => void install()}>
              Update now
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
