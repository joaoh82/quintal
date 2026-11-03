import {
  AGENT_SCOPES,
  RUNTIMES,
  bodyOfAgent,
  isAgentScope,
  modelChoice,
  runtimeById,
  type AgentCardRef,
  type AgentMachineRef,
  type AgentScope,
  type RuntimeStatus,
} from '@quintal/shared';
import type { AgentListEntry } from '@quintal/shared/db';

/**
 * The office's agents as an agent reads and writes them.
 *
 * Pure, like the rest of this directory's rules: what a card shows to whom,
 * and which machine, runtime and model a request comes to, can be asked of a
 * test without a room or a database. The room reads the rows and does the
 * writing.
 */

/** A machine as the room reads it: its row in `agent_hosts`, whose owner it already filtered on. */
export interface RosterMachine {
  label: string;
  lastSeenAt: Date | null;
  runtimes: readonly RuntimeStatus[];
}

/**
 * What one agent sees of another. `yours` decides everything past the board's
 * own columns: an agent's standing orders and what it is allowed to do are its
 * owner's business, as they are in Settings. `whole` adds the instructions.
 */
export function agentCardOf(
  agent: AgentListEntry,
  reader: { ownerUserId: string; here: ReadonlySet<string>; whole?: boolean },
): AgentCardRef {
  const yours = agent.ownerUserId === reader.ownerUserId;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    character: bodyOfAgent(agent),
    owner: agent.ownerName,
    yours,
    status: agent.status,
    here: reader.here.has(agent.id),
    lastSeenAt: agent.lastSeenAt,
    runtime: agent.runtimeId,
    model: agent.modelId,
    machine: agent.hostLabel,
    ...(yours
      ? {
          enabled: agent.enabled,
          scopes: agent.scopes,
          maxSessions: agent.maxSessions,
          madeBy: agent.createdByAgentName,
          ...(reader.whole ? { instructions: agent.instructions } : {}),
        }
      : {}),
  };
}

/** A machine in the terms `agent_create` takes: what is installed there and can be driven. */
export function agentMachineOf(machine: RosterMachine): AgentMachineRef {
  return {
    label: machine.label,
    lastSeenAt: machine.lastSeenAt?.getTime() ?? null,
    runtimes: machine.runtimes.flatMap((status) => {
      const runtime = runtimeById(status.id);
      if (!status.installed || !runtime || runtime.acp.kind === 'none') return [];
      return [{ id: runtime.id, label: runtime.label, models: status.models?.choices.map((choice) => choice.id) ?? [] }];
    }),
  };
}

/**
 * Scopes as a model names them, in the canonical order so two equal sets
 * cannot look different. Refused, not dropped as a form's are: a model told
 * its "deploy" scope was stored would go on believing it.
 */
export function parseWantedScopes(raw: unknown): { scopes: AgentScope[] } | { refusal: string } {
  if (!Array.isArray(raw)) return { refusal: `scopes is a list of: ${AGENT_SCOPES.join(', ')}.` };
  const unknown = raw.filter((scope) => typeof scope !== 'string' || !isAgentScope(scope));
  if (unknown.length > 0) {
    return { refusal: `No scope called ${unknown.map(String).join(', ')}. There are: ${AGENT_SCOPES.join(', ')}.` };
  }
  return { scopes: AGENT_SCOPES.filter((scope) => raw.includes(scope)) };
}

/** A name a person would use for a runtime: its id or its label. */
function runtimeNamed(wanted: string) {
  const needle = wanted.trim().toLowerCase();
  return RUNTIMES.find((runtime) => runtime.id === needle || runtime.label.toLowerCase() === needle) ?? null;
}

export interface LaunchWanted {
  /** A machine by name, null for none, absent for "say nothing about it". */
  machine?: string | null;
  runtime?: string;
  model?: string | null;
}

export interface LaunchNow {
  hostLabel: string | null;
  runtimeId: string | null;
  modelId: string | null;
}

export type LaunchOutcome =
  /** `launch` is undefined when nothing was asked of it, and null when it runs nowhere. */
  | { ok: true; launch: { runtimeId: string; hostLabel: string; modelId: string | null } | null | undefined }
  | { ok: false; refusal: string };

/**
 * Where an agent runs, from what was asked and what it runs on now.
 *
 * Stricter than the settings form, because a person sees the pickers and a
 * model does not: a machine that never reported, or a runtime not installed
 * there, is refused rather than saved to wait forever with nothing saying why.
 * What it runs on already needs no fresh report, as in `modelFor`: changing
 * something else must not cost a choice already made.
 *
 * `now` is the agent being changed, or for a new one its maker: an agent asked
 * for a colleague gets one beside it on the same runtime, and never on the
 * maker's model, since nobody asked for that and a model costs money.
 */
export function resolveLaunch(
  wanted: LaunchWanted,
  now: LaunchNow | null,
  machines: readonly RosterMachine[],
  options: { creating: boolean },
): LaunchOutcome {
  if (wanted.machine === null) return { ok: true, launch: null };
  const asked = wanted.machine !== undefined || wanted.runtime !== undefined || wanted.model !== undefined;
  if (!asked && !options.creating) return { ok: true, launch: undefined };

  const names = machines.map((machine) => machine.label).join(', ') || 'none has reported yet';
  const label = wanted.machine?.trim() || now?.hostLabel || null;
  if (label === null) {
    return asked
      ? { ok: false, refusal: `Say which machine. Your owner's are: ${names}.` }
      : { ok: true, launch: null };
  }
  const machine = machines.find((candidate) => candidate.label.toLowerCase() === label.toLowerCase());
  if (!machine) return { ok: false, refusal: `Your owner has no machine called ${label}. Theirs are: ${names}.` };

  const offered = agentMachineOf(machine).runtimes;
  const offeredNames = offered.map((runtime) => runtime.id).join(', ') || 'none';
  const named = wanted.runtime !== undefined ? runtimeNamed(wanted.runtime) : null;
  if (wanted.runtime !== undefined && !named) return { ok: false, refusal: `No runtime called ${wanted.runtime}. ${machine.label} has: ${offeredNames}.` };
  const runtimeId = named?.id ?? now?.runtimeId ?? null;
  if (runtimeId === null) return { ok: false, refusal: `Say which runtime. ${machine.label} has: ${offeredNames}.` };

  const unmoved = !options.creating && now?.hostLabel === machine.label && now?.runtimeId === runtimeId;
  if (!unmoved && !offered.some((runtime) => runtime.id === runtimeId)) {
    return { ok: false, refusal: `${machine.label} cannot run ${runtimeById(runtimeId)?.label ?? runtimeId}. It has: ${offeredNames}.` };
  }

  const kept = unmoved ? (now?.modelId ?? null) : null;
  const modelId = wanted.model === undefined ? kept : wanted.model?.trim() || null;
  if (modelId !== null && modelId !== kept) {
    const status = machine.runtimes.find((entry) => entry.id === runtimeId);
    if (!modelChoice(status, modelId)) {
      const choices = status?.models?.choices.map((choice) => choice.id).join(', ') || 'none it has said';
      return { ok: false, refusal: `${machine.label} did not report a model "${modelId}" for ${runtimeId}. It offers: ${choices}. Leave it out for the default.` };
    }
  }
  return { ok: true, launch: { runtimeId, hostLabel: machine.label, modelId } };
}

/** What happens next after a write, in the words the agent passes on. */
export function agentChangeNote(name: string, fields: readonly string[], onMachine: string | null, enabled: boolean): string {
  const lines: string[] = [];
  const restarting = fields.some((field) => field !== 'scopes' && field !== 'enabled' && field !== 'character');
  if (fields.includes('character')) lines.push(`${name}'s new look shows within moments, with no restart.`);
  if (fields.includes('enabled')) {
    lines.push(enabled ? `${name} is on.` : `${name} is off; a machine stops running it on its next look.`);
  }
  if (restarting && onMachine && enabled) {
    lines.push(`${name} restarts on ${onMachine} to take this up, within moments if its fleet is running; a turn it is on may be cut short.`);
  } else if (fields.includes('machine') && !onMachine) {
    lines.push(`${name} is on no machine now, so nothing runs it until it is given one.`);
  } else if (restarting && !onMachine) {
    lines.push(`${name} is on no machine, so this reaches it the next time it is started.`);
  }
  if (fields.includes('scopes')) lines.push(`${name}'s scopes take effect from its next session.`);
  return lines.join(' ');
}

/** What happens to an agent just made. Says plainly when nothing will run it. */
export function agentMadeNote(name: string, machine: string | null): string {
  return machine
    ? `${name} starts on ${machine} and walks in within moments, if that machine's fleet is running.`
    : `${name} exists but is on no machine, so nothing runs it yet. Give it one with agent_update, or your owner can under Settings → Agents.`;
}
