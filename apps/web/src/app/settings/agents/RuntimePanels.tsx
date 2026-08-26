'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { describeHostFailure } from '@/lib/host';
import { useHost } from '@/lib/use-host';
import type { RuntimeStatus } from '@quintal/shared';

import { RuntimeList, RuntimeRows, type Host } from './RuntimeList';

/**
 * Every machine that can run agents, each appearing exactly once.
 *
 * Two things know about runtimes and they overlap. The harness *reports* what a
 * machine has when it connects, which is the only way a browser office can ever
 * know — it cannot see anybody's PATH. The desktop app can also be *asked*
 * directly, which is faster and works before anything has connected.
 *
 * On the computer running the app, both are true at once, and showing both is
 * how this first shipped: one panel headed "This computer" and another headed
 * with the same machine's name, listing the same runtimes and the same repos
 * directory. Two panels, one machine, no way to tell that from looking.
 *
 * So the live answer wins for the machine it came from, and that machine is
 * dropped from the reported list. It keeps its real name and gains a note
 * saying it is the one you are sitting at, because "This computer" as a heading
 * threw away the only fact that let you match it to an agent's assignment.
 */
export function RuntimePanels({ hosts }: { hosts: Host[] }) {
  const { host, ready } = useHost();
  const [local, setLocal] = useState<{
    label: string;
    reposDir: string;
    runtimes: RuntimeStatus[];
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function look() {
    if (!host) return;
    setBusy(true);
    setProblem(null);
    try {
      const [runtimes, reposDir, status] = await Promise.all([
        host.detectRuntimes(),
        host.reposDir(),
        host.hostStatus(),
      ]);
      setLocal({ label: status.label, reposDir, runtimes });
    } catch (error: unknown) {
      setProblem(describeHostFailure(error));
    }
    setBusy(false);
  }

  async function choose() {
    if (!host) return;
    setBusy(true);
    setProblem(null);
    try {
      const picked = await host.pickReposDir();
      // Null means the dialog was dismissed. Not a failure, and not a reason to
      // change anything.
      if (picked !== null) {
        setLocal((was) => (was ? { ...was, reposDir: picked } : was));
      }
    } catch (error: unknown) {
      setProblem(describeHostFailure(error));
    }
    setBusy(false);
  }

  useEffect(() => {
    if (host) void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  // Before the host has been looked for, render exactly what the server did.
  // Anything else is a hydration mismatch — see `useHost`.
  if (!ready || !host) return <RuntimeList hosts={hosts} />;

  // Matched on the registered name, which is now what `hostStatus` reports.
  // Comparing against the live hostname is what let one computer show up twice
  // the moment its network renamed it.
  const elsewhere = local
    ? hosts.filter((reported) => reported.label !== local.label)
    : hosts;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border p-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-sm font-semibold">{local?.label ?? 'This computer'}</h2>
          <span className="text-muted-foreground text-xs">this computer</span>
          {local ? (
            <span className="text-muted-foreground ml-auto font-mono text-[11px]">
              repos: {local.reposDir}
            </span>
          ) : null}
        </div>

        {problem ? (
          <p className="mt-2 text-xs text-red-600">{problem}</p>
        ) : local === null ? (
          <p className="text-muted-foreground mt-1 text-xs">Looking…</p>
        ) : (
          <RuntimeRows runtimes={local.runtimes} />
        )}

        <div className="mt-3 flex gap-2">
          <Button variant="outline" onClick={() => void look()} disabled={busy}>
            {busy ? 'Looking…' : 'Look again'}
          </Button>
          <Button variant="outline" onClick={() => void choose()} disabled={busy}>
            Change repos folder
          </Button>
        </div>
      </section>

      {elsewhere.length > 0 ? <RuntimeList hosts={elsewhere} /> : null}
    </div>
  );
}
