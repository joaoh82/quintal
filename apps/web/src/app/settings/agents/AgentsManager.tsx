'use client';

import {
  AGENT_SCOPES,
  AGENT_SPRITE_KEYS,
  DEFAULT_AGENT_SCOPES,
  RUNTIMES,
  type AgentScope,
} from '@quintal/shared';
import type { AgentListEntry } from '@quintal/shared/db';
import Link from 'next/link';

import { WorkspaceBadge } from './RuntimeList';
import { useActionState, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  assignAgentAction,
  createAgentAction,
  revokeAgentAction,
  type CreateAgentState,
} from './actions';

const INITIAL: CreateAgentState = { ok: false };

function when(ms: number | null): string {
  if (ms === null) return 'never';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

interface AgentsManagerProps {
  agents: AgentListEntry[];
  currentUserId: string;
  canAdministerAll: boolean;
  /** Registered machines, for assigning an agent somewhere it can boot. */
  machines: string[];
}

export function AgentsManager({
  agents,
  currentUserId,
  canAdministerAll,
  machines,
}: AgentsManagerProps) {
  const [state, formAction, pending] = useActionState(createAgentAction, INITIAL);
  const [copied, setCopied] = useState(false);

  const live = agents.filter((agent) => agent.revokedAt === null);
  const revoked = agents.filter((agent) => agent.revokedAt !== null);

  return (
    <div className="flex flex-col gap-8">
      {/* The key is rendered here and nowhere else, ever again. */}
      {state.ok && state.key ? (
        <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <h2 className="text-sm font-semibold">
            {state.agentName} is ready — here is its key
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            This is the only time it will ever be shown. Only a hash is stored, so
            if you lose it you must revoke this agent and create another.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="bg-background flex-1 overflow-x-auto rounded border px-3 py-2 font-mono text-xs">
              {state.key}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(state.key ?? '');
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-muted-foreground mt-3 font-mono text-[11px]">
            AGENT_KEY={state.key?.slice(0, 12)}… QUINTAL_URL=http://localhost:3000 pnpm
            demo-agent
          </p>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-semibold">New agent</h2>
        <p className="text-muted-foreground mt-1 text-xs">
          An agent belongs to you. Your name appears next to it everywhere it acts,
          and its whole history is on the record.
        </p>

        <form action={formAction} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Name</span>
            <Input name="name" placeholder="reviewer" required className="w-48" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Sprite</span>
            <select
              name="spriteKey"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              defaultValue={AGENT_SPRITE_KEYS[0]}
            >
              {AGENT_SPRITE_KEYS.map((sprite) => (
                <option key={sprite} value={sprite}>
                  {sprite}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium">Scopes</legend>
            <div className="flex h-9 items-center gap-3">
              {AGENT_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    name="scopes"
                    value={scope}
                    defaultChecked={DEFAULT_AGENT_SCOPES.includes(scope as AgentScope)}
                    className="size-3.5"
                  />
                  {scope}
                </label>
              ))}
            </div>
          </fieldset>

          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Create agent'}
          </Button>

          {/* Assigning a machine is what turns "created" into "running". Left
              blank, the agent is exactly what it always was: something you
              start yourself with the key shown above. */}
          {machines.length > 0 ? (
            <div className="flex w-full flex-wrap items-end gap-3 border-t pt-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Runs on</span>
                <select
                  name="hostLabel"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  defaultValue=""
                >
                  <option value="">nowhere — I&rsquo;ll start it myself</option>
                  {machines.map((machine) => (
                    <option key={machine} value={machine}>
                      {machine}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Runtime</span>
                <select
                  name="runtimeId"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  defaultValue="claude-code"
                >
                  {RUNTIMES.filter((runtime) => runtime.acp.kind !== 'none').map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Repo</span>
                <Input name="repoSpec" placeholder="api  ·  * for all" className="w-44" />
              </label>

              <p className="text-muted-foreground w-full text-[11px]">
                Assigned to a machine, it boots there within a few seconds — no key
                to copy. <span className="font-mono">*</span> roots it at your whole
                repos directory, so it can find or clone a project it hasn&rsquo;t
                been told about.
              </p>
            </div>
          ) : null}
        </form>

        {state.error ? (
          <p className="mt-2 text-xs text-rose-600">{state.error}</p>
        ) : null}
      </section>

      <section>
        <h2 className="text-sm font-semibold">
          Agents <span className="text-muted-foreground font-normal">({live.length})</span>
        </h2>

        {live.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            No agents yet. The office is all human.
          </p>
        ) : (
          <ul className="mt-3 divide-y rounded-lg border">
            {live.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                canRevoke={canAdministerAll || agent.ownerUserId === currentUserId}
                machines={machines}
              />
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 ? (
        <section>
          <h2 className="text-muted-foreground text-sm font-semibold">
            Revoked ({revoked.length})
          </h2>
          <p className="text-muted-foreground mt-1 text-xs">
            Kept, not deleted: an audit log that points at agents which no longer
            exist is not an audit log.
          </p>
          <ul className="mt-3 divide-y rounded-lg border opacity-60">
            {revoked.map((agent) => (
              <AgentRow key={agent.id} agent={agent} canRevoke={false} machines={[]} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function AgentRow({
  agent,
  canRevoke,
  machines,
}: {
  agent: AgentListEntry;
  canRevoke: boolean;
  machines: string[];
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className="text-sky-500">
          ◆
        </span>
        {agent.name}
      </span>

      <span className="text-muted-foreground text-xs">{agent.ownerName}&rsquo;s</span>

      {agent.status ? (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {agent.status}
        </span>
      ) : null}

      {/* What it can reach on disk, for the same reason its owner's name is
          here: the answer should not require reading a file on another machine. */}
      <WorkspaceBadge
        path={agent.workspacePath}
        rootedAtReposDir={agent.rootedAtReposDir}
      />

      <span className="text-muted-foreground ml-auto text-xs">
        created {when(agent.createdAt)}
      </span>
      <span className="text-muted-foreground text-xs">
        {agent.revokedAt !== null
          ? `revoked ${when(agent.revokedAt)}`
          : `seen ${when(agent.lastSeenAt)}`}
      </span>

      {/* Where it runs, changeable after the fact — the ordering that forced
          you to register a machine first was an artefact of the create form,
          not a rule about agents. */}
      {canRevoke && machines.length > 0 && agent.revokedAt === null ? (
        <form
          action={assignAgentAction}
          className="order-last flex w-full flex-wrap items-center gap-2 pt-1"
        >
          <input type="hidden" name="agentId" value={agent.id} />
          <span className="text-muted-foreground text-[11px]">Runs on</span>
          <select
            name="hostLabel"
            defaultValue={agent.hostLabel ?? ''}
            className="border-input bg-background h-7 rounded border px-2 text-xs"
          >
            <option value="">nowhere</option>
            {machines.map((machine) => (
              <option key={machine} value={machine}>
                {machine}
              </option>
            ))}
          </select>
          <select
            name="runtimeId"
            defaultValue={agent.runtimeId ?? 'claude-code'}
            className="border-input bg-background h-7 rounded border px-2 text-xs"
          >
            {RUNTIMES.filter((runtime) => runtime.acp.kind !== 'none').map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.label}
              </option>
            ))}
          </select>
          {/* `required` so the browser blocks an empty submit before it can
              become a thrown server error — this form has no inline error
              slot, and a full-page overlay is not how you say "fill this in". */}
          <input
            name="repoSpec"
            defaultValue={agent.repoSpec ?? ''}
            placeholder="api · * for all"
            required
            className="border-input bg-background h-7 w-36 rounded border px-2 text-xs"
          />
          <button type="submit" className="text-xs underline-offset-2 hover:underline">
            Save
          </button>
        </form>
      ) : null}

      <Link
        href={`/settings/agents/${agent.id}/log`}
        className="text-xs underline underline-offset-2"
      >
        log
      </Link>

      {canRevoke ? (
        <form action={revokeAgentAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="ghost" size="sm" className="text-rose-600">
            Revoke
          </Button>
        </form>
      ) : null}
    </li>
  );
}
