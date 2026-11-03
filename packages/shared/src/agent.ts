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
 * `commands` is whether it may read the office's `!` commands and write
 * them as its owner: make one where its owner may, change one its owner
 * made. A command an agent writes is a brief other agents will follow, so
 * every one it makes or changes records the agent beside the owner and is
 * headed that way wherever it reaches.
 *
 * `agents` is whether it may read the office's agents and make or change its
 * owner's, as its owner. It is the one scope that hands out the others, so
 * what it may give is bounded by what it holds: see `scopesBeyondGrant`.
 *
 * `run` is whether its harness may answer the runtime's own "may I run this
 * tool?" question on the owner's behalf. Without it, every command the
 * runtime is unsure about is put to the owner where the conversation is, and
 * silence denies. Enforced by the harness, not the office: the office never
 * sees the question, only the audit line that answers it.
 */
export const AGENT_SCOPES = ['chat', 'move', 'status', 'dm', 'board', 'commands', 'routines', 'agents', 'run'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ['chat', 'move', 'status', 'dm', 'board', 'commands', 'routines', 'agents', 'run'];

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
  board: 'Read the office board, write notes on it and hand them to your agents.',
  commands: 'List the office\u2019s commands, make new ones and change yours, as you.',
  routines: 'Keep routines on itself and your other agents: list, make, change, pause and delete them, as you.',
  agents: 'See the office\u2019s agents, and make or change yours as you. It can give only scopes it holds, and never this one.',
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
 * A companion rather than an edit, because the general note above is still
 * true wherever the runtime does ask. Where it never has, "Quintal stops
 * answering for it" describes stopping something that never happened, and an
 * owner would come away believing they had taken authority back. They have
 * not; the runtime never gave Quintal any.
 */
export const RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS =
  'Nothing observable changes. This agent\u2019s runtime has never been seen to ask Quintal for permission, so there was nothing for Quintal to stop answering — what the agent may do is decided inside the runtime, by the runtime\u2019s own settings.';

/**
 * The scopes an agent may give another: those it holds, and never `agents`.
 *
 * Holding is the bound because anything wider is a way up: an agent whose
 * owner withdrew `run` must not get it back by making a colleague that has
 * it. `agents` is left out so that handing out agents stays one level deep:
 * an agent that could give it could make agents that make agents, each a
 * runtime process on somebody's machine, faster than anybody could read the
 * list. An owner gives it, in Settings.
 */
export function grantableScopes(holder: readonly AgentScope[]): AgentScope[] {
  return holder.filter((scope) => scope !== 'agents');
}

/**
 * What a change of scopes would add that the agent making it may not give.
 * Empty means it may. Taking one away is always allowed, and so is leaving
 * alone one it could not give itself, so only what arrives is counted.
 */
export function scopesBeyondGrant(
  holder: readonly AgentScope[],
  before: readonly AgentScope[],
  after: readonly AgentScope[],
): AgentScope[] {
  const grantable = grantableScopes(holder);
  return after.filter((scope) => !before.includes(scope) && !grantable.includes(scope));
}

/**
 * The scopes of the target an agent lacks, which keep it from changing that
 * target at all. Empty means it may. A rule on the grant is not enough: an
 * agent without `run` could otherwise rewrite the instructions of one with
 * it, and have it do what it could not.
 */
export function scopesOutOfReach(
  holder: readonly AgentScope[],
  target: readonly AgentScope[],
): AgentScope[] {
  return target.filter((scope) => !holder.includes(scope));
}

/**
 * How many agents one owner's agents may make in a window, together. Counted
 * by owner rather than by agent, since every one of them starts a runtime
 * process on the owner's machine. Enough for "make me three reviewers"; not
 * enough for a runtime in a loop to fill a laptop before anybody looks.
 */
export const AGENT_CREATES_PER_WINDOW = 3;
export const AGENT_CREATE_WINDOW_MS = 60_000;

/** Past this many live agents an owner's agents stop making more. Settings still can. */
export const AGENT_CREATE_OWNED_MAX = 20;

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
  /** Its owner changed which MCP servers it is given. Names only: arguments can hold tokens. */
  'agent.mcp_servers_changed',
  /** A keypair was registered for it (credentials v2), replacing any before. */
  'agent.credential_registered',
  /** Another agent, or itself, changed it for its owner: which fields, and by whom. */
  'agent.changed_by_agent',
  /** It answers to another name now: what it was and what it is. */
  'agent.renamed',
  /** It walks around in another body now: which it was and which it is. */
  'agent.character_changed',
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
  /** It read the board, or one note. */
  'command.board_list',
  'command.board_get',
  /** It wrote a note, or changed one: the number and what changed. */
  'command.board_create',
  'command.board_update',
  /** It read the office's commands, or one. */
  'command.command_list',
  'command.command_get',
  /** It made a command, or changed one, as its owner: the name and what changed. */
  'command.command_create',
  'command.command_update',
  'command.routine_list',
  'command.routine_get',
  'command.routine_create',
  'command.routine_update',
  'command.routine_delete',
  'command.agent_list',
  'command.agent_get',
  /** It made an agent, or changed one, as its owner. The target's own log has the matching line. */
  'command.agent_create',
  'command.agent_update',
  /** A routine of its fired: the line was spoken in its owner's DM. `made_up` when it was due while the agent was away. */
  'routine.fired',
  'routine.made_up',
  /** A routine of its was due and not spoken: the agent was away, or still on the previous run. */
  'routine.missed',
  'routine.skipped',
  'command.memory_get',
  'command.memory_set',
  'command.host_report',
  'command.rejected',
  'effect.spoke',
  'effect.posted',
  'effect.moved',
  'effect.status_changed',
  'effect.memory_written',
  /**
   * The task on its card changed: begun, its pull request seen or moved on,
   * or ended. Only what its harness said in `agent:task`; the office keeps no
   * task of its own.
   */
  'effect.task_changed',
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
  return normalisePromptProse(input, AGENT_INSTRUCTIONS_MAX_LENGTH);
}

/** `normaliseAgentInstructions` with a cap of the caller's: the same prose rules. */
export function normalisePromptProse(input: unknown, maxLength: number): string {
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
  return points.length > maxLength ? points.slice(0, maxLength).join('') : cleaned;
}

/** Agent names are shown next to human ones, so hold them to the same shape. */
export const AGENT_NAME_MAX_LENGTH = 40;

export function normaliseAgentName(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, AGENT_NAME_MAX_LENGTH);
}
