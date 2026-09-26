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
/**
 * What an agent may do. `dm` is whether it may be in a direct message at all
 * — a private conversation with its owner — as distinct from `chat`, which is
 * speaking in shared places. Without it, the only way to talk to an agent is
 * where everybody can read it.
 *
 * `run` is whether its harness may answer the runtime's own "may I run this
 * tool?" question on the owner's behalf. Without it, every command the
 * runtime is unsure about is put to the owner where the conversation is, and
 * silence denies. Enforced by the harness, not the office: the office never
 * sees the question, only the audit line that answers it.
 */
export const AGENT_SCOPES = ['chat', 'move', 'status', 'dm', 'run'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ['chat', 'move', 'status', 'dm', 'run'];

export function isAgentScope(value: string): value is AgentScope {
  return (AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * What each scope means, in the words the settings page uses.
 *
 * Here rather than in the page because `run` is the one an owner is most
 * likely to misread, and the reading has to be the same wherever it is shown.
 * It is not "may run commands": it is "the harness answers the runtime's
 * permission questions for it, every time, without anybody seeing them".
 */
export const AGENT_SCOPE_NOTES: Readonly<Record<AgentScope, string>> = {
  chat: 'Speak in rooms and channels.',
  move: 'Walk around the office.',
  status: 'Set its own status line.',
  dm: 'Hold a direct message with you.',
  run: 'Answer the runtime\u2019s "may I run this?" questions automatically, for every turn, with nothing shown to you. Without it each one is put to you and silence denies.',
};

/**
 * What withdrawing `run` does, and — just as important — what it does not.
 *
 * Turning the scope off stops *Quintal* answering for the agent. It does not
 * reach inside the runtime: an allow rule somebody added with the runtime's
 * own CLI, or a standing grant a runtime kept for itself, is untouched and
 * still in force. Saying "revoked" without that sentence would be the same
 * false promise QUIN-53 exists to remove, pointed the other way.
 */
export const RUN_SCOPE_WITHDRAWAL_NOTE =
  'Quintal stops answering for it from its next session. Allow rules kept by the runtime itself are not revoked by this \u2014 they live in the runtime\u2019s own settings and are removed there.';

/**
 * What withdrawing `run` does on a runtime that has never been seen to ask.
 *
 * A companion rather than an edit, because the general note is still true for
 * Claude Code and Oh My Pi: there, withdrawing the scope really does change
 * who answers the next question. On Codex and opencode there was never a
 * question to answer — QUIN-53 drove both end to end and neither sent
 * `session/request_permission` at all — so "Quintal stops answering for it"
 * describes stopping something that never happened. An owner reading the
 * general note there would come away believing they had taken authority back.
 * They have not; the runtime never gave Quintal any.
 */
export const RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS =
  'Nothing observable changes. This agent\u2019s runtime has never been seen to ask Quintal for permission, so there was nothing for Quintal to stop answering — what the agent may do is decided inside the runtime, by the runtime\u2019s own settings.';

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

// --- parallelism -----------------------------------------------------------

/**
 * How many conversations one agent may answer at the same time.
 *
 * A number of *turns in flight*, not of sessions: an agent keeps a session per
 * conversation regardless, and this is how many of them may be running a
 * prompt at once. One is the old behaviour — a DM sent while the agent is
 * reviewing a pull request in a channel waits for the review to finish, with
 * nothing to show for it. Ten is enough that a person and a couple of
 * channels never queue behind each other; thirty-two is where a laptop stops
 * being the right machine to run it on.
 *
 * Each turn is one runtime process (Claude Code, Codex, …), spawned when it
 * is first needed, so the number is a ceiling and not a cost until it is
 * used.
 */
/**
 * How many agent-to-agent hops a mention may travel before it wakes nobody.
 *
 * A human's line is hop 0. An agent that was woken by it and names another
 * agent posts at hop 1, that one at hop 2, and so on. Three teammates
 * naming each other back would otherwise ping-pong forever, with everybody
 * else watching. Past this depth an agent's line is still delivered and
 * shown — nothing is lost — it just starts no turn, and the office writes
 * `effect.mention_suppressed` in the speaker's log so the silence can be
 * explained. Four is enough for "I'll take it" / "no, I have context" /
 * "fine, yours" / "thanks" and not enough for a loop to be a nuisance.
 */
export const AGENT_MENTION_MAX_HOPS = 4;

export const AGENT_PARALLELISM_DEFAULT = 10;
export const AGENT_PARALLELISM_MIN = 1;
export const AGENT_PARALLELISM_MAX = 32;

/**
 * Coerce a parallelism setting from a form, an API or a row. `null` for
 * "use the office default" (blank, absent, or not a number); out-of-range
 * values are clamped rather than refused so a stale row keeps working.
 */
export function normaliseParallelism(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim().length === 0) return null;
  const parsed = Math.round(Number(raw));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(AGENT_PARALLELISM_MAX, Math.max(AGENT_PARALLELISM_MIN, parsed));
}

/** Whether a value is a parallelism the settings page may save as given. */
export function isValidParallelism(value: number): boolean {
  return (
    Number.isInteger(value) && value >= AGENT_PARALLELISM_MIN && value <= AGENT_PARALLELISM_MAX
  );
}

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
  /**
   * Its owner changed what it is allowed to do. Separate from the profile
   * because a scope is an authorization: "when did this stop being allowed
   * to run things?" needs an answer with a name and a time against it.
   */
  'agent.scopes_changed',
  /** A keypair was registered for it (credentials v2), replacing any before. */
  'agent.credential_registered',
  /** Its owner changed or cleared one of its memory slugs from the settings page. */
  'agent.memory_edited',
  'session.connected',
  'session.disconnected',
  'session.rejected',
  'session.revoked',
  'command.say',
  'command.move_to',
  'command.set_status',
  'command.emote',
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
  /** The office asked this agent for one line to a colleague; the setting was on. */
  'effect.banter',
  /**
   * This agent named other agents in a line that had already travelled the
   * most agent-to-agent hops a mention may. The line was delivered and
   * shown; it woke nobody. See `AGENT_MENTION_MAX_HOPS`.
   */
  'effect.mention_suppressed',
  /**
   * The runtime asked to run a tool and the question went to the owner.
   * Its `requestId` is how the three approval rows below join up.
   */
  'approval.requested',
  /** The owner chose an option on the card. Records who, and which option. */
  'approval.decided',
  /**
   * The question stopped waiting: answered, denied, expired, cancelled, or
   * approved outright by the `run` scope — which is the one that never
   * interrupts anybody, and so is the one that most needs to be on the record.
   */
  'approval.resolved',
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
