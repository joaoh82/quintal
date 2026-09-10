'use client';

import {
  AGENT_CORE_MEMORY_MAX_BYTES,
  AGENT_CORE_MEMORY_SLUG,
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_SCOPES,
  AGENT_SPRITE_KEYS,
  DEFAULT_AGENT_SCOPES,
  RUNTIMES,
  npubEncode,
  runtimeById,
  truncateNpub,
  type AgentScope,
  type RuntimeStatus,
} from '@quintal/shared';
import type { AgentListEntry } from '@quintal/shared/db';
import Link from 'next/link';

import { RegisterKey } from './RegisterKey';
import { WorkspaceBadge } from './RuntimeList';
import { useActionState, useState } from 'react';

import { RelativeTime } from '@/components/RelativeTime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import {
  assignAgentAction,
  createAgentAction,
  revokeAgentAction,
  saveAgentMemoryAction,
  saveAgentProfileAction,
  type SaveAgentMemoryState,
  type SaveAgentProfileState,
  setAgentEnabledAction,
  type CreateAgentState,
} from './actions';

const INITIAL: CreateAgentState = { ok: false };

/** What a machine reported it can run, keyed by the label a form picks. */
export interface ReportedHost {
  label: string;
  runtimes: RuntimeStatus[];
}

/** What an agent carries, as its owner may read and change it. */
export interface AgentMemoryView {
  /** The `core` slug, whole: identity, standing instructions, `!remember` notes. */
  core: string;
  /** Every other slug, by name and size. Filed notes; read only if it comes up. */
  others: Array<{ slug: string; bytes: number; updatedAt: number }>;
}

interface AgentsManagerProps {
  agents: AgentListEntry[];
  /** By agent id, for the agents this person may edit. */
  memories: Record<string, AgentMemoryView>;
  currentUserId: string;
  /** The key the signed-in person signs with — what an attestation is made with. */
  currentUserPubkey: string;
  canAdministerAll: boolean;
  /** Registered machines, for assigning an agent somewhere it can boot. */
  machines: string[];
  /** What each machine said it has — the model picker draws from this. */
  hosts: ReportedHost[];
}

/**
 * The model picker, for one machine and one runtime.
 *
 * Offers only what that machine reported the runtime offering, because that
 * is the only list the harness will honour: an agent asked for a model its
 * runtime never advertised refuses to run rather than running on another.
 * The default is a real option, not an empty string that means "whatever".
 */
function ModelSelect({
  hosts,
  hostLabel,
  runtimeId,
  value,
  onChange,
  compact,
}: {
  hosts: ReportedHost[];
  hostLabel: string;
  runtimeId: string;
  value: string;
  onChange: (modelId: string) => void;
  compact?: boolean;
}) {
  const status = hosts
    .find((host) => host.label === hostLabel)
    ?.runtimes.find((entry) => entry.id === runtimeId);
  const models = status?.models ?? null;
  const known = models !== null && models.choices.some((choice) => choice.id === value);
  const runtime = runtimeById(runtimeId);
  // A choice already saved that the list does not (yet) contain stays
  // selectable, so saving the row for another reason does not throw it away.
  // The action accepts it as unchanged; only a *new* choice must be on the
  // machine's list.
  const keep = value.length > 0 && !known;

  return (
    <select
      name="modelId"
      value={known || keep ? value : ''}
      onChange={(event) => onChange(event.target.value)}
      disabled={hostLabel.length === 0 || (models === null && !keep)}
      title={
        hostLabel.length === 0
          ? 'Pick a machine first'
          : models === null
            ? status?.models === undefined
              ? `${hostLabel} has not reported which models ${runtime?.label ?? runtimeId} offers yet — it does so a few seconds after its fleet boots`
              : `${runtime?.label ?? runtimeId} offers no model choice on ${hostLabel}`
            : undefined
      }
      className={
        compact
          ? 'border-input bg-background h-7 rounded border px-2 text-xs disabled:opacity-50'
          : 'border-input bg-background h-9 rounded-md border px-3 text-sm disabled:opacity-50'
      }
    >
      <option value="">
        {models === null
          ? status?.models === undefined && hostLabel.length > 0
            ? 'default — models not reported yet'
            : `default`
          : `default${models.current ? ` (${models.choices.find((c) => c.id === models.current)?.label ?? models.current})` : ''}`}
      </option>
      {keep ? (
        <option value={value}>
          {value}
          {models === null ? ' — not on this machine’s list' : ' — not verified'}
        </option>
      ) : null}
      {models?.choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}

export function AgentsManager({
  agents,
  memories,
  currentUserId,
  currentUserPubkey,
  canAdministerAll,
  machines,
  hosts,
}: AgentsManagerProps) {
  const [state, formAction, pending] = useActionState(createAgentAction, INITIAL);
  const [copied, setCopied] = useState(false);
  // The create form's launch trio is controlled so the model picker can follow
  // the machine and runtime it depends on.
  const [newHost, setNewHost] = useState('');
  const [newRuntime, setNewRuntime] = useState('claude-code');
  const [newModel, setNewModel] = useState('');

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

          <label className="flex w-full flex-col gap-1">
            <span className="text-xs font-medium">
              Description <span className="text-muted-foreground">— optional</span>
            </span>
            <Input
              name="description"
              placeholder="Reviews pull requests and keeps an eye on CI"
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
              className="w-full"
            />
            <span className="text-muted-foreground text-xs">
              One line, shown on its card in the office. For people, not the model.
            </span>
          </label>

          <label className="flex w-full flex-col gap-1">
            <span className="text-xs font-medium">
              Instructions <span className="text-muted-foreground">— optional</span>
            </span>
            <textarea
              name="instructions"
              rows={4}
              maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
              placeholder={'Be terse.\nAnswer in Portuguese.\nAlways link the PR you are talking about.'}
              className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
            />
            <span className="text-muted-foreground text-xs">
              Goes into its system prompt, above anything it has worked out for
              itself. This is the part it cannot overwrite.
            </span>
          </label>

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
                  value={newHost}
                  onChange={(event) => setNewHost(event.target.value)}
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
                  value={newRuntime}
                  onChange={(event) => setNewRuntime(event.target.value)}
                >
                  {RUNTIMES.filter((runtime) => runtime.acp.kind !== 'none').map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Model</span>
                <ModelSelect
                  hosts={hosts}
                  hostLabel={newHost}
                  runtimeId={newRuntime}
                  value={newModel}
                  onChange={setNewModel}
                />
              </label>

              <p className="text-muted-foreground w-full text-[11px]">
                Assigned to a machine, it boots there within a few seconds — no key
                to copy. It works in that machine&rsquo;s shared workspace, with your
                repos directory under <span className="font-mono">REPOS/</span>; say
                which project is its own in its instructions.
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
                ownerPubkey={agent.ownerUserId === currentUserId ? currentUserPubkey : null}
                memory={memories[agent.id]}
                machines={machines}
                hosts={hosts}
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
              <AgentRow key={agent.id} agent={agent} canRevoke={false} machines={[]} hosts={[]} />
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
  ownerPubkey = null,
  memory,
  machines,
  hosts,
}: {
  agent: AgentListEntry;
  canRevoke: boolean;
  /** What it carries, when this person may edit it. */
  memory?: AgentMemoryView | undefined;
  /**
   * The signed-in person's key when they own this agent, else null. Only an
   * owner can vouch for an agent — an admin may revoke it, but cannot sign
   * for somebody else.
   */
  ownerPubkey?: string | null;
  machines: string[];
  hosts: ReportedHost[];
}) {
  const [host, setHost] = useState(agent.hostLabel ?? '');
  const [runtime, setRuntime] = useState(agent.runtimeId ?? 'claude-code');
  const [model, setModel] = useState(agent.modelId ?? '');

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <span aria-hidden className="text-sky-500">
          ◆
        </span>
        {agent.name}
      </span>

      <span className="text-muted-foreground text-xs">{agent.ownerName}&rsquo;s</span>

      {agent.hostLabel !== null && !agent.enabled && agent.revokedAt === null ? (
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
          disabled
        </span>
      ) : null}

      {agent.status ? (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {agent.status}
        </span>
      ) : null}

      {/* Its own key, when it has one: the same fact a person's card shows,
          because an agent with a key of its own is somebody the office can
          name without having minted anything for it. */}
      {agent.pubkey ? (
        <span
          className="text-muted-foreground font-mono text-[11px]"
          title={npubEncode(agent.pubkey)}
        >
          {truncateNpub(npubEncode(agent.pubkey))}
        </span>
      ) : null}

      {/* Which model, next to which runtime: the card should say what the
          agent is running on without opening the form under it. */}
      {agent.runtimeId !== null && agent.hostLabel !== null ? (
        <span className="text-muted-foreground font-mono text-[11px]">
          {runtimeById(agent.runtimeId)?.label ?? agent.runtimeId}
          {agent.modelId ? ` · ${agent.modelId}` : ''}
        </span>
      ) : null}

      {/* What it can reach on disk, for the same reason its owner's name is
          here: the answer should not require reading a file on another machine. */}
      <WorkspaceBadge path={agent.workspacePath} />

      <span className="text-muted-foreground ml-auto text-xs">
        created <RelativeTime at={agent.createdAt} />
      </span>
      <span className="text-muted-foreground text-xs">
        {agent.revokedAt !== null ? (
          <>
            revoked <RelativeTime at={agent.revokedAt} />
          </>
        ) : (
          <>
            seen <RelativeTime at={agent.lastSeenAt} />
          </>
        )}
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
            value={host}
            onChange={(event) => setHost(event.target.value)}
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
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            className="border-input bg-background h-7 rounded border px-2 text-xs"
          >
            {RUNTIMES.filter((entry) => entry.acp.kind !== 'none').map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <ModelSelect
            hosts={hosts}
            hostLabel={host}
            runtimeId={runtime}
            value={model}
            onChange={setModel}
            compact
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

      {ownerPubkey && agent.revokedAt === null ? (
        <RegisterKey
          agentId={agent.id}
          agentName={agent.name}
          ownerPubkey={ownerPubkey}
          currentPubkey={agent.pubkey}
        />
      ) : null}

      {canRevoke && agent.hostLabel !== null && agent.revokedAt === null ? (
        <form action={setAgentEnabledAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <input type="hidden" name="enabled" value={agent.enabled ? 'false' : 'true'} />
          <Button type="submit" variant="ghost" size="sm">
            {agent.enabled ? 'Disable' : 'Enable'}
          </Button>
        </form>
      ) : null}

      {canRevoke ? (
        <form action={revokeAgentAction}>
          <input type="hidden" name="agentId" value={agent.id} />
          <Button type="submit" variant="ghost" size="sm" className="text-rose-600">
            Revoke
          </Button>
        </form>
      ) : null}

      {/*
        Collapsed by default. Instructions are prose and the row is a list; a
        four-line textarea open on every agent turns a roster into a form.
      */}
      {canRevoke && agent.revokedAt === null ? (
        <details className="w-full pt-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Description and instructions
          </summary>
          <AgentProfileForm agent={agent} />
        </details>
      ) : null}

      {/* What `!remember` put there, and what the agent wrote itself: read it,
          change it, or take a line out. The chat box has `!forget` for the
          quick case; this is for seeing the whole thing. */}
      {canRevoke && agent.revokedAt === null && memory ? (
        <details className="w-full pt-1">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Memory
            {memory.core.trim().length > 0 || memory.others.length > 0 ? '' : ' (empty)'}
          </summary>
          <AgentMemoryForm agent={agent} memory={memory} />
        </details>
      ) : null}
    </li>
  );
}

/**
 * Editing what an agent is, with something to show for it.
 *
 * Its own component so each row owns its result: one `useActionState` shared
 * across the list would show "Saved" under every agent when one was saved.
 *
 * Saving used to say nothing at all. The action returned void, the form had no
 * state, and a failure threw — so clicking Save looked identical whether it had
 * worked, been refused, or never reached the server. That matters more here
 * than on most forms, because the effect is deliberately not instant: the agent
 * is restarted by its host on the next fleet poll, and without a word from the
 * form there is no way to tell "waiting" from "broken".
 */
function AgentProfileForm({ agent }: { agent: AgentListEntry }) {
  const [state, formAction, pending] = useActionState(saveAgentProfileAction, {
    ok: false,
  } as SaveAgentProfileState);

  // Guard against a result from a different row, which cannot happen while the
  // state is per-component but would be silent if that ever changed.
  const mine = state.agentId === agent.id;

  return (
    <form action={formAction} className="mt-2 flex flex-col gap-2">
      <input type="hidden" name="agentId" value={agent.id} />
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Description</span>
        <Input
          name="description"
          defaultValue={agent.description}
          maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
          placeholder="Reviews pull requests and keeps an eye on CI"
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Instructions</span>
        <textarea
          name="instructions"
          rows={4}
          defaultValue={agent.instructions}
          maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
          disabled={pending}
          className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {mine && state.ok ? (
          <span className="text-xs text-emerald-600">
            Saved — {agent.name} restarts within about 15 seconds to pick it up.
          </span>
        ) : null}
        {mine && state.error ? (
          <span className="text-destructive text-xs" role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
      {!mine || !state.ok ? (
        <span className="text-muted-foreground text-xs">
          Applied by restarting the agent, so anything it was in the middle of is
          dropped.
        </span>
      ) : null}
    </form>
  );
}

/**
 * The agent's memory, in front of its owner.
 *
 * Core is a textarea, because it is prose the owner may have dictated with
 * `!remember` and may now want to prune line by line — "always finish with a
 * joke" was funny for a week. Saving it empty clears it. The other slugs are
 * the agent's own filing and are listed by name and size; each can be
 * forgotten whole, which is all an owner needs to do with a note they cannot
 * see the point of.
 *
 * Applied by restarting the agent, like an instruction: an owner's edit is a
 * change to what the agent is told, and a running session has already been
 * told the old version.
 */
function AgentMemoryForm({ agent, memory }: { agent: AgentListEntry; memory: AgentMemoryView }) {
  const [state, formAction, pending] = useActionState(saveAgentMemoryAction, {
    ok: false,
  } as SaveAgentMemoryState);
  const mine = state.agentId === agent.id;

  return (
    <div className="mt-2 flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="agentId" value={agent.id} />
        <input type="hidden" name="slug" value={AGENT_CORE_MEMORY_SLUG} />
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">Core memory</span>
          <span className="text-muted-foreground text-[11px]">
            Loaded into every session. What you said with{' '}
            <code className="font-mono">!remember</code>, and what it kept for itself.
            One note per line; delete a line to make it forget. Save empty to clear.
          </span>
          <textarea
            name="content"
            rows={Math.min(12, Math.max(3, memory.core.split('\n').length + 1))}
            defaultValue={memory.core}
            maxLength={AGENT_CORE_MEMORY_MAX_BYTES}
            disabled={pending}
            spellCheck={false}
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring/50 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
            placeholder="Nothing yet. `!remember` in the office writes here."
          />
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? 'Saving…' : 'Save memory'}
          </Button>
          {mine && state.slug === AGENT_CORE_MEMORY_SLUG && state.ok ? (
            <span className="text-xs text-emerald-600">
              Saved — {agent.name} restarts within about 15 seconds to read it.
            </span>
          ) : null}
          {mine && state.slug === AGENT_CORE_MEMORY_SLUG && state.error ? (
            <span className="text-destructive text-xs" role="alert">
              {state.error}
            </span>
          ) : null}
        </div>
      </form>

      {memory.others.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">Filed notes</span>
          <span className="text-muted-foreground text-[11px]">
            Slugs the agent wrote for itself and reads back only when they come up.
          </span>
          <ul className="divide-y rounded border text-xs">
            {memory.others.map((entry) => (
              <li key={entry.slug} className="flex items-center gap-3 px-3 py-1.5">
                <code className="font-mono">{entry.slug}</code>
                <span className="text-muted-foreground">{entry.bytes} bytes</span>
                <span className="text-muted-foreground ml-auto">
                  <RelativeTime at={entry.updatedAt} />
                </span>
                <form action={formAction}>
                  <input type="hidden" name="agentId" value={agent.id} />
                  <input type="hidden" name="slug" value={entry.slug} />
                  <input type="hidden" name="content" value="" />
                  <button
                    type="submit"
                    disabled={pending}
                    className="text-rose-600 underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Forget
                  </button>
                </form>
              </li>
            ))}
          </ul>
          {mine && state.slug !== AGENT_CORE_MEMORY_SLUG && state.error ? (
            <span className="text-destructive text-xs" role="alert">
              {state.error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
