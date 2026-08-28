'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { describeHostFailure, type OfficeList } from '@/lib/host';
import { useHost } from '@/lib/use-host';

/**
 * The offices this app can open.
 *
 * An office is an environment, not a preference: its own people, its own
 * agents, its own registration of this machine. Nothing crosses between two of
 * them — so they are a list you move between, the way Slack and Buzz do it,
 * rather than a URL you edit in place.
 *
 * Adding one lives in the app's own picker rather than here, because that
 * screen has to work when there is no office to load this page from. This is
 * the view for when you are already somewhere and want to be elsewhere.
 */
export function Offices() {
  const { host, ready } = useHost();
  const [listed, setListed] = useState<OfficeList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!host) return;
    void host
      .listOffices()
      .then(setListed)
      .catch((error: unknown) => setProblem(describeHostFailure(error)));
  }, [host]);

  if (!ready) return null;

  if (!host) {
    return (
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Offices</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          You are in this office through a browser, which reaches exactly the one
          in the address bar. The desktop app keeps several and moves between
          them.
        </p>
      </section>
    );
  }

  async function act(what: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await what();
    } catch (error: unknown) {
      // A switch that worked never gets here: the app restarts out from under
      // this page, which is the point.
      setProblem(describeHostFailure(error));
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Offices</h2>
      <p className="text-muted-foreground mt-1 text-xs">
        Each one is its own place, with its own people and its own agents. They
        do not talk to each other. Switching restarts Quintal, so it only ever
        holds the keys to the office you are in.
      </p>

      <ul className="mt-3 flex flex-col gap-px">
        {(listed?.offices ?? []).map((office) => {
          const here = office.url === listed?.active;
          return (
            <li
              key={office.url}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0"
            >
              <span className="text-sm font-medium">{office.label}</span>
              {here ? (
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                  you are here
                </span>
              ) : null}
              <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                {office.url}
              </span>
              {here ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => host.switchOffice(office.url))}
                >
                  Open
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {listed !== null && listed.offices.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Only this one so far.
        </p>
      ) : null}

      {problem ? <p className="mt-2 text-xs text-red-600">{problem}</p> : null}

      <Button
        variant="outline"
        className="mt-3"
        disabled={busy}
        onClick={() => void act(() => host.openOfficePicker())}
      >
        Add or switch office…
      </Button>
    </section>
  );
}
