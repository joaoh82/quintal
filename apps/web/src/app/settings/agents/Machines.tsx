'use client';

import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  createHostTokenAction,
  revokeHostTokenAction,
  type HostTokenState,
} from './actions';

const INITIAL: HostTokenState = { ok: false };

interface MachineRow {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  ownerUserId: string;
}

function when(ms: number | null): string {
  if (ms === null) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Machines that can run your agents.
 *
 * Registering one is what makes "create an agent here, it starts over there"
 * possible at all: a web page cannot launch a process on your laptop, so the
 * laptop holds a credential and asks what it should be running.
 *
 * The page is deliberately blunt about what that credential can do. It is more
 * powerful than an agent key, and a reader should not have to infer that from
 * the absence of a warning.
 */
export function Machines({
  machines,
  currentUserId,
}: {
  machines: MachineRow[];
  currentUserId: string;
}) {
  const [state, formAction, pending] = useActionState(createHostTokenAction, INITIAL);
  const [copied, setCopied] = useState(false);

  const live = machines.filter((row) => row.revokedAt === null);

  return (
    <section className="rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Machines</h2>
      <p className="text-muted-foreground mt-1 max-w-2xl text-xs">
        A machine registered here can run agents you create in this page — no
        copying keys, no editing a config file. Quintal can&rsquo;t start a process
        on your computer, so your computer holds a token and asks what it should
        be running.
      </p>

      {state.ok && state.token ? (
        <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="text-xs font-medium">
            {state.label} is registered — run this on it, once:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-[11px]">
              npx quintal-acp login --token {state.token} --url {typeof window === 'undefined' ? '' : window.location.origin}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(
                  `npx quintal-acp login --token ${state.token ?? ''} --url ${window.location.origin}`,
                );
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-[11px]">
            Shown once, like an agent key — only a hash is stored. Treat it as more
            sensitive than one: it can act as <em>any</em> agent you assign to this
            machine, including ones you create later. Revoke it here if it leaks.
          </p>
        </div>
      ) : null}

      <form action={formAction} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Machine name</span>
          <Input name="label" placeholder="laptop" required className="w-48" />
        </label>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? 'Registering…' : 'Register machine'}
        </Button>
      </form>

      {state.error ? <p className="mt-2 text-xs text-rose-600">{state.error}</p> : null}

      {live.length > 0 ? (
        <ul className="mt-4 divide-y rounded-md border">
          {live.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-medium">{row.label}</span>
              <span className="text-muted-foreground text-xs">
                registered {when(row.createdAt)}
              </span>
              <span className="text-muted-foreground ml-auto text-xs">
                {row.lastSeenAt === null
                  ? 'never connected'
                  : `last asked ${when(row.lastSeenAt)}`}
              </span>
              {row.ownerUserId === currentUserId ? (
                <form action={revokeHostTokenAction}>
                  <input type="hidden" name="tokenId" value={row.id} />
                  <button type="submit" className="text-xs text-rose-600 hover:underline">
                    Revoke
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
