/**
 * What an agent is, in Quintal's terms.
 *
 * The design stance, which every decision below serves: agents are **legible
 * workers**, not companions. Always visibly non-human, always attributed to a
 * human owner, quiet unless spoken to. An agent that could be mistaken for a
 * person — or that acts with nobody accountable for it — is a bug, not a
 * feature.
 */

import { tidyDisplayText } from './workspace.js';

/**
 * What an agent is allowed to do to the world. Reading the room and using its
 * own memory are not scoped: those don't change anything anyone else can see.
 * These three do.
 */
export const AGENT_SCOPES = ['chat', 'move', 'status'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ['chat', 'move', 'status'];

export function isAgentScope(value: string): value is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(value);
}

/** Parse the `scopes` JSON column, discarding anything unrecognised. */
export function parseScopes(raw: unknown): AgentScope[] {
  if (!Array.isArray(raw)) return [...DEFAULT_AGENT_SCOPES];
  const scopes = raw.filter((value): value is AgentScope =>
    typeof value === 'string' && isAgentScope(value),
  );
  return scopes.length > 0 ? scopes : [];
}

// --- API keys --------------------------------------------------------------

/**
 * Prefix on every agent key. Makes a leaked key greppable in logs and
 * recognisable in a secret scanner.
 */
export const AGENT_KEY_PREFIX = 'qa_';

/**
 * A machine's credential, as distinct from an agent's.
 *
 * An agent key identifies one agent; a host token identifies one *machine* and
 * may act as any agent its owner has assigned to that machine. That is strictly
 * more power, and the trade is deliberate: the alternative is for the office to
 * hand out agent keys it defined, which means storing them recoverably instead
 * of as hashes. One revocable credential on your laptop beats plaintext
 * credentials in a database.
 *
 * Different prefix so the two can never be confused in a log, an error message
 * or a paste.
 */
export const HOST_TOKEN_PREFIX = 'qh_';

/** Bytes of entropy behind a key. 32 is well past brute force. */
export const AGENT_KEY_BYTES = 32;

/** Shown in lists so a human can tell two keys apart without seeing either. */
export function agentKeyHint(key: string): string {
  return `${key.slice(0, AGENT_KEY_PREFIX.length + 4)}…${key.slice(-4)}`;
}

// --- limits ----------------------------------------------------------------

/**
 * Agents are quiet by default, and the server enforces it rather than trusting
 * them to behave. An agent that floods the room is indistinguishable from a
 * broken one, and either way nobody can work.
 */
export const AGENT_CHAT_INTERVAL_MS = 2_000;
export const AGENT_MOVE_INTERVAL_MS = 500;

/** Presence line under the nameplate: "running tests…". */
export const AGENT_STATUS_MAX_LENGTH = 60;

// --- memory ----------------------------------------------------------------

/**
 * The slug an agent's harness loads on every turn. Kept small on purpose: it
 * costs context on every single request the agent makes.
 */
export const AGENT_CORE_MEMORY_SLUG = 'core';
export const AGENT_CORE_MEMORY_MAX_BYTES = 8 * 1024;
export const AGENT_MEMORY_MAX_BYTES = 32 * 1024;

/** Longest a memory slug may be, and what it may contain. */
export const AGENT_MEMORY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function memoryLimitFor(slug: string): number {
  return slug === AGENT_CORE_MEMORY_SLUG
    ? AGENT_CORE_MEMORY_MAX_BYTES
    : AGENT_MEMORY_MAX_BYTES;
}

export function isValidMemorySlug(slug: string): boolean {
  return AGENT_MEMORY_SLUG_PATTERN.test(slug);
}

// --- audit -----------------------------------------------------------------

/**
 * Every kind of thing that lands in `agent_events`.
 *
 * The rule is: an agent should never be able to do something that leaves no
 * trace. Inbound commands and the outbound consequences that changed the world
 * both get a row, so the log reads as a story rather than a list of requests.
 */
export const AGENT_EVENT_KINDS = [
  'agent.created',
  'agent.revoked',
  /** Its owner changed what it says it is, or how it was told to behave. */
  'agent.profile_changed',
  'session.connected',
  'session.disconnected',
  'session.rejected',
  'session.revoked',
  'command.say',
  'command.move_to',
  'command.set_status',
  'command.look_around',
  'command.messages_get',
  'command.memory_get',
  'command.memory_set',
  'command.host_report',
  'command.rejected',
  'effect.spoke',
  'effect.posted',
  'effect.moved',
  'effect.status_changed',
  'effect.memory_written',
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** A row from `agent_events`, as the UI sees it. */
export interface AgentEventView {
  id: string;
  kind: AgentEventKind | string;
  payload: unknown;
  createdAt: number;
}

// --- presentation ----------------------------------------------------------

/**
 * Sprite choices offered when creating an agent. Deliberately the *same* sheet
 * humans use: an agent is marked out by its nameplate and ring, never by being
 * given a robot costume. Costumes make them cute; badges make them legible.
 */
export const AGENT_SPRITE_KEYS = ['slate', 'amber', 'violet'] as const;
export type AgentSpriteKey = (typeof AGENT_SPRITE_KEYS)[number];

export const DEFAULT_AGENT_SPRITE: AgentSpriteKey = 'slate';

export function isAgentSpriteKey(value: string): value is AgentSpriteKey {
  return (AGENT_SPRITE_KEYS as readonly string[]).includes(value);
}

/** One line about what an agent does, shown on its card. */
export const AGENT_DESCRIPTION_MAX_LENGTH = 280;

/**
 * How long an owner's instructions to their agent may be.
 *
 * Larger than a description because this is prose with a job to do, and small
 * enough that it cannot crowd out the conversation it is prepended to — the
 * system prompt is paid for on every priming turn.
 */
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 2_000;

/**
 * What an agent's owner says it does, for people to read.
 *
 * Display text, so it gets the same containment as every other name and label:
 * newlines collapsed, bidi controls stripped. It is drawn on a card next to
 * other people's, and a description that can reach into the row below it is a
 * description that can impersonate one.
 */
export function normaliseAgentDescription(input: unknown): string {
  if (typeof input !== 'string') return '';
  return tidyDisplayText(input, AGENT_DESCRIPTION_MAX_LENGTH);
}

/**
 * What an agent's owner tells it to be, for the model to read.
 *
 * Deliberately *not* `tidyDisplayText`. Instructions are prose — "be terse;
 * answer in Portuguese; always link the PR" reads as lines, and collapsing
 * them into one paragraph would be editing somebody's meaning to satisfy a
 * renderer that never sees this. It goes into a system prompt, not onto a card.
 *
 * Still contained, because unbounded text in a prompt is its own problem:
 * control characters other than newline and tab are stripped, runs of blank
 * lines collapse, and the whole thing is clamped by code point so an emoji
 * cannot be cut in half.
 *
 * Not a trust boundary. The owner writes this for their own agent, so there is
 * nobody to defend them from here — the cap is about cost and legibility.
 */
export function normaliseAgentInstructions(input: unknown): string {
  if (typeof input !== 'string') return '';
  const cleaned = input
    .replace(/\r\n?/g, '\n')
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
      '',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const points = Array.from(cleaned);
  return points.length > AGENT_INSTRUCTIONS_MAX_LENGTH
    ? points.slice(0, AGENT_INSTRUCTIONS_MAX_LENGTH).join('')
    : cleaned;
}

/** Agent names are shown next to human ones, so hold them to the same shape. */
export const AGENT_NAME_MAX_LENGTH = 40;

export function normaliseAgentName(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, AGENT_NAME_MAX_LENGTH);
}
