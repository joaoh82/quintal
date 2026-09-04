import { RUNTIMES, isUsable, runtimeById, type RuntimeStatus } from '@quintal/shared';

import { RelativeTime } from '@/components/RelativeTime';
import { Button } from '@/components/ui/button';

import { forgetHostReportAction } from './actions';

export interface Host {
  label: string;
  reposDir: string;
  runtimes: RuntimeStatus[];
  lastSeenAt: Date;
}

/**
 * What each machine of yours can actually run.
 *
 * Reported inward by the harness, never discovered here — the office cannot see
 * anybody's PATH, and a hosted Quintal never will. So this list is empty until
 * a fleet connects, and that emptiness is honest rather than a bug.
 *
 * Unsupported runtimes are listed rather than hidden. "Installed, but it has no
 * ACP mode" and "not installed" are different problems with different fixes,
 * and a runtime you can see marked unsupported beats one that silently isn't
 * there.
 */
export function RuntimeList({ hosts }: { hosts: Host[] }) {
  if (hosts.length === 0) {
    return (
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold">Agent runtimes</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          No other machine has reported in. A web page cannot see your PATH, so a
          machine appears here once it connects — open Quintal in the desktop app
          on it, or run <code className="font-mono">quintal-acp up</code> there.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {hosts.map((host) => (
        <section key={host.label} className="rounded-lg border p-4">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h2 className="text-sm font-semibold">{host.label}</h2>
            <span className="text-muted-foreground text-xs">
              seen <RelativeTime at={host.lastSeenAt.getTime()} />
            </span>
            {host.reposDir ? (
              <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                repos: {host.reposDir}
              </span>
            ) : null}

            {/* A machine that has gone — renamed, retired — otherwise stays here
                forever. Forgetting is not revoking: one that still exists comes
                straight back the next time its harness connects. */}
            <form action={forgetHostReportAction} className="ml-2">
              <input type="hidden" name="label" value={host.label} />
              <Button type="submit" variant="ghost" size="sm">
                Forget
              </Button>
            </form>
          </div>

          <RuntimeRows runtimes={host.runtimes} />
        </section>
      ))}

      <p className="text-muted-foreground text-xs">
        Quintal speaks{' '}
        <a
          href="https://agentclientprotocol.com"
          className="underline underline-offset-2"
          target="_blank"
          rel="noreferrer noopener"
        >
          ACP
        </a>
        , so there is nothing to install <em>into</em> your agent CLI and nothing to
        register. A runtime marked <strong>via adapter</strong> is wrapped by a small
        published process that <code className="font-mono">npx</code> fetches on
        demand. All Quintal needs from your machine is the CLI itself, installed and
        signed in.
      </p>
    </div>
  );
}

/** Where an agent is rooted, as its harness reported it. */
export function WorkspaceBadge({
  path,
  rootedAtReposDir,
}: {
  path: string;
  rootedAtReposDir: boolean;
}) {
  if (!path) return null;
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
        rootedAtReposDir
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
          : 'bg-muted text-muted-foreground'
      }`}
      title={
        rootedAtReposDir
          ? `Rooted at your whole repos directory — this agent can read and write every project under ${path}`
          : `Rooted at ${path}`
      }
    >
      {rootedAtReposDir ? `all repos · ${path}` : path}
    </span>
  );
}

export function runtimeLabel(id: string): string {
  return runtimeById(id)?.label ?? id;
}


/**
 * The catalogue, marked up with what a given machine actually has.
 *
 * Every runtime is listed, including the ones that cannot work: "installed, but
 * it has no ACP mode" and "not installed" are different problems with different
 * fixes, and a runtime you can see marked unsupported beats one that silently
 * is not there.
 */
export function RuntimeRows({ runtimes }: { runtimes: RuntimeStatus[] }) {
  return (
    <ul className="mt-3 flex flex-col gap-px">
            {RUNTIMES.map((spec) => {
              const status =
                runtimes.find((entry) => entry.id === spec.id) ??
                ({ id: spec.id, installed: false, path: null } satisfies RuntimeStatus);
              const ready = isUsable(status);
              const noAcp = spec.acp.kind === 'none';

              return (
                <li
                  key={spec.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b py-2 last:border-b-0"
                >
                  <span className={ready ? 'text-sm' : 'text-muted-foreground text-sm'}>
                    {spec.label}
                  </span>

                  <span className="text-muted-foreground font-mono text-[11px]">
                    {spec.acp.kind === 'native'
                      ? 'native ACP'
                      : spec.acp.kind === 'adapter'
                        ? 'via adapter'
                        : 'no ACP'}
                  </span>

                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 text-[11px] ${
                      ready
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : noAcp
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {ready ? 'Ready' : noAcp ? 'Unsupported' : 'Not installed'}
                  </span>

                  <p className="text-muted-foreground w-full text-[11px]">
                    {ready ? (
                      <>
                        Use <code className="font-mono">--agent {spec.id}</code>
                        {status.path ? (
                          <span className="opacity-60"> · {status.path}</span>
                        ) : null}
                        {status.models ? (
                          <span className="opacity-60">
                            {' '}
                            · models: {status.models.choices.map((c) => c.label).join(', ')}
                          </span>
                        ) : status.models === null ? (
                          <span className="opacity-60"> · no model choice</span>
                        ) : null}
                      </>
                    ) : noAcp ? (
                      spec.evidence
                    ) : (
                      <>
                        Install it and it works here — nothing to configure in Quintal:{' '}
                        <code className="font-mono">{spec.install}</code>
                      </>
                    )}
                  </p>
                </li>
              );
            })}
    </ul>
  );
}
