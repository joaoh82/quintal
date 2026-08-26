'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { describeHostFailure, type FleetState, type LogLine } from '@/lib/host';
import { useHost } from '@/lib/use-host';

/**
 * Start and stop the agents assigned to this machine.
 *
 * Only in the app: a browser cannot run a process, and this is the surface that
 * makes that difference legible rather than mysterious. In a browser it renders
 * the instructions for the machine you would run instead, which is a real answer
 * — "open in the app" with nothing behind it is not.
 *
 * Polls rather than subscribes. The state worth showing changes on the order of
 * seconds, a poll cannot miss an event it was not listening for, and there is no
 * subscription to leak when this unmounts.
 */
const POLL_MS = 2000;

export function FleetControl() {
  const { host, ready } = useHost();
  const [state, setState] = useState<FleetState | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const tail = useRef<HTMLPreElement | null>(null);

  const refresh = useCallback(async () => {
    if (!host) return;
    try {
      const [next, lines] = await Promise.all([host.fleetStatus(), host.fleetLogs()]);
      setState(next);
      setLogs(lines);
    } catch {
      // A poll that failed is not news. The next one is two seconds away, and
      // an error banner that appears because one tick lost a race is noise.
    }
  }, [host]);

  useEffect(() => {
    if (!host) return;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [host, refresh]);

  useEffect(() => {
    if (showLogs && tail.current) tail.current.scrollTop = tail.current.scrollHeight;
  }, [logs, showLogs]);

  // Nothing until the host has been looked for — see `useHost`.
  if (!ready) return null;

  if (!host) {
    return (
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Running agents</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          A web page cannot start a process on your computer. Open Quintal in the
          desktop app to run agents here, or run{' '}
          <code className="font-mono">quintal-acp up</code> on the machine you
          want them on.
        </p>
      </section>
    );
  }

  async function act(what: 'start' | 'stop') {
    if (!host) return;
    setBusy(true);
    setProblem(null);
    try {
      if (what === 'start') await host.startFleet();
      else await host.stopFleet();
    } catch (error: unknown) {
      setProblem(describeHostFailure(error));
    }
    setBusy(false);
    await refresh();
  }

  const running = state?.state === 'running';

  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">Running agents</h2>
        <FleetBadge state={state} />
        <div className="ml-auto flex gap-2">
          {logs.length > 0 ? (
            <Button variant="outline" onClick={() => setShowLogs((open) => !open)}>
              {showLogs ? 'Hide log' : 'Log'}
            </Button>
          ) : null}
          <Button onClick={() => void act(running ? 'stop' : 'start')} disabled={busy}>
            {busy ? 'Working…' : running ? 'Stop' : 'Start'}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground mt-1 text-xs">
        This computer runs the agents assigned to it. Starting asks the office
        what belongs here — enabling and disabling an agent below is what decides
        that, and takes effect without restarting anything.
      </p>

      {problem ? <p className="mt-2 text-xs text-red-600">{problem}</p> : null}

      {showLogs ? (
        <pre
          ref={tail}
          className="bg-muted mt-3 max-h-64 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed"
        >
          {logs.map((line, index) => (
            <div key={index} className={line.stream === 'err' ? 'text-red-600' : undefined}>
              {line.text}
            </div>
          ))}
        </pre>
      ) : null}
    </section>
  );
}

function FleetBadge({ state }: { state: FleetState | null }) {
  if (state === null) return null;

  if (state.state === 'running') {
    return (
      <span className="text-xs text-green-700">running · pid {state.pid}</span>
    );
  }
  if (state.state === 'crashed') {
    // A crash is a fact worth showing. The alternative is agents that quietly
    // stop answering and a settings page that looks fine.
    return (
      <span className="text-xs text-red-600">
        stopped on its own{state.code === null ? '' : ` (exit ${state.code})`}
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs">not running</span>;
}
