import type { ApprovalOption, ApprovalRequest, RuntimeOptionSemantics } from '@quintal/shared';
import {
  activityText,
  compareGrants,
  describeGrant,
  grantIsExplainable,
  grantIsPerCall,
  grantLabel,
  optionSemantics,
} from '@quintal/shared';

/**
 * The bookkeeping behind "may I run this?".
 *
 * Kept out of `AgentRunner` because all of it is decidable without a runtime:
 * which runtime options we can honestly offer, what the action actually was,
 * and — the part that used to be wrong — which open question an answer names.
 *
 * The old rule matched the tool name and fell back to the oldest question.
 * Two turns asking about `Bash` at once could not be told apart, so "yes"
 * authorised whichever had been waiting longest, which is not what anybody
 * meant. Here an answer that cannot be pinned to exactly one question is
 * refused, and the agent asks again with handles to quote back.
 */

/** Everything not established, under a shorter name for use below. */
const UNKNOWN: RuntimeOptionSemantics = {
  breadth: 'unknown',
  lifetime: 'unknown',
  persistsAt: null,
  evidence: 'Not established.',
};

/** What the owner said, or what silence means. */
export type PermissionDecision = 'once' | 'always' | 'deny';

/** One question the runtime is holding a tool on. */
export interface PendingApproval {
  /** What is published and answered by. The identity of this ask. */
  request: ApprovalRequest;
  /** `worker:toolCallId` — how a crash or a cancel finds its questions. */
  callId: string;
  /**
   * The options the runtime offered, verbatim.
   *
   * Kept because the answer is selected long after the ask: the card is
   * built now and clicked minutes later, and the option sent back must come
   * from this list rather than from anything reconstructed.
   */
  options: unknown;
  workerIndex: number;
  /** The runner's turn, when the question belongs to one. */
  turnId: number | null;
  scope: string;
  settled: boolean;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * A short, quotable name for one request, for the text fallback.
 *
 * Six hex characters of the id. A person cannot be asked to type a UUID, and
 * without something to type the fallback cannot distinguish two questions
 * about the same tool at all.
 */
export function approvalHandle(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 6);
}

/** One option exactly as the runtime sent it. Nothing here is ever invented. */
export interface OfferedOption {
  optionId?: unknown;
  kind?: unknown;
  name?: unknown;
}

/** An allow we are prepared to take, and what taking it would mean. */
export interface AllowChoice {
  /** The runtime's own option id, verbatim. */
  optionId: string;
  kind: string | null;
  semantics: RuntimeOptionSemantics;
}

/** Only the entries that are shaped like an option at all. */
function offered(options: unknown): OfferedOption[] {
  if (!Array.isArray(options)) return [];
  return (options as unknown[]).filter(
    (option): option is OfferedOption =>
      typeof option === 'object' && option !== null && typeof (option as OfferedOption).optionId === 'string',
  );
}

function kindOf(option: OfferedOption): string | null {
  return typeof option.kind === 'string' ? option.kind : null;
}

/**
 * The narrowest allow this runtime offered whose breadth and lifetime we can
 * state — and nothing at all when we cannot state either.
 *
 * Narrowest, not first. `allow_always` is a kind, and Claude Code's plan-exit
 * request carries three of them: "use auto mode", "clear context and use auto
 * mode", and "bypass permissions". Reading the kind and taking the first
 * match is how an office ends up clearing a conversation it meant to approve
 * a file write in.
 *
 * Unknown is refused rather than ranked last. An option nobody has measured
 * cannot be labelled, and an unlabelable option must not be offered — which
 * is the same rule as "no button promises what it cannot explain", applied
 * one layer down.
 */
export function pickAllow(runtimeId: string, options: unknown): AllowChoice | null {
  const candidates = offered(options)
    .filter((option) => kindOf(option)?.startsWith('allow') === true)
    .map((option) => ({
      optionId: option.optionId as string,
      kind: kindOf(option),
      semantics: optionSemantics(runtimeId, { optionId: option.optionId, kind: option.kind }),
    }))
    .filter((candidate) => grantIsExplainable(candidate.semantics));
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => compareGrants(a.semantics, b.semantics))[0]!;
}

/**
 * The refusal that denies this call and nothing else.
 *
 * Deliberately `reject_once` or nothing. A runtime that also offers "Always
 * reject" is offering a standing refusal, and taking one would deny requests
 * the owner was never shown — the mirror image of the standing grant this
 * whole module exists to stop. With no per-call refusal we answer
 * `cancelled`, which every ACP agent must accept.
 */
export function pickReject(runtimeId: string, options: unknown): AllowChoice | null {
  for (const option of offered(options)) {
    if (kindOf(option) !== 'reject_once') continue;
    const semantics = optionSemantics(runtimeId, { optionId: option.optionId, kind: option.kind });
    // An unmeasured `reject_once` is still a refusal of this one call: that
    // is what the kind means in ACP, and refusing less is the safe direction.
    return { optionId: option.optionId as string, kind: 'reject_once', semantics };
  }
  return null;
}

/**
 * Which options a card may offer, and what its buttons say.
 *
 * Built from the *same* `pickAllow` the answer is later selected with, so the
 * words on the button and the option sent to the runtime cannot drift apart.
 * That is the whole acceptance condition of QUIN-53: no label may promise
 * less authority, or a shorter life, than the option it takes.
 *
 * A runtime whose allow options are all unmeasured gets Deny alone — "we
 * cannot tell you what Allow would do here" is a real answer, and a better
 * one than a button that guesses. A runtime that offers no reject still gets
 * Deny: a cancelled outcome is a refusal by another name.
 */
export function supportedOptions(runtimeId: string, options: unknown): ApprovalOption[] {
  const allow = pickAllow(runtimeId, options);
  return [
    ...(allow ? [{ id: 'allow_once' as const, label: grantLabel(allow.semantics) }] : []),
    { id: 'deny' as const, label: 'Deny' },
  ];
}

/** Why no option could be taken, when none could. */
export type SelectionRefusal =
  /** Nothing offered whose breadth and lifetime are established. */
  | 'unexplained_allow'
  /** The run scope may only take a per-call allow, and none was offered. */
  | 'not_per_call';

/** What the runtime will be told, and what we believe that means. */
export interface RuntimeSelection {
  /** The runtime's own option id, or null to answer `cancelled`. */
  optionId: string | null;
  kind: string | null;
  semantics: RuntimeOptionSemantics;
  refusal: SelectionRefusal | null;
  /** Asked for a standing grant and got a per-call one instead. */
  downgraded: boolean;
}

/**
 * The option to send back, decided from what was established rather than from
 * what the kinds are called.
 *
 * `automatic` is the `run` scope answering on the owner's behalf. It may take
 * a genuine per-call allow and nothing else: an automatic answer nobody sees
 * must not leave a standing grant behind, and an option whose breadth is
 * unknown certainly must not. When there is no per-call allow the runtime is
 * told `cancelled` and the refusal is named — an explicit, documented policy
 * rather than a quiet widening.
 */
export function chooseRuntimeOption(
  runtimeId: string,
  options: unknown,
  decision: PermissionDecision,
  automatic = false,
): RuntimeSelection {
  if (decision === 'deny') {
    const reject = pickReject(runtimeId, options);
    return {
      optionId: reject?.optionId ?? null,
      kind: reject?.kind ?? null,
      semantics: reject?.semantics ?? UNKNOWN,
      refusal: null,
      downgraded: false,
    };
  }

  const allow = pickAllow(runtimeId, options);
  if (!allow) {
    return { optionId: null, kind: null, semantics: UNKNOWN, refusal: 'unexplained_allow', downgraded: false };
  }
  if (automatic && !grantIsPerCall(allow.semantics)) {
    return { optionId: null, kind: null, semantics: allow.semantics, refusal: 'not_per_call', downgraded: false };
  }
  return {
    optionId: allow.optionId,
    kind: allow.kind,
    semantics: allow.semantics,
    refusal: null,
    downgraded: decision === 'always' && grantIsPerCall(allow.semantics),
  };
}

/** The sentence an audit line and a chat reply both use. */
export function describeSelection(selection: RuntimeSelection): string {
  if (selection.optionId === null) return 'nothing the runtime offered could be explained';
  return describeGrant(selection.semantics);
}

/**
 * One sanitized line about what the tool would do.
 *
 * The command when the runtime supplied one, otherwise the paths it named,
 * otherwise nothing — a summary invented from a tool's title would be a
 * guess presented as a fact, and this is the text somebody approves on.
 */
export function summariseToolCall(toolCall: unknown, limit = 400, toolName = ''): string {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const call = toolCall as {
    rawInput?: unknown;
    locations?: unknown;
    kind?: unknown;
  };
  const input =
    call.rawInput && typeof call.rawInput === 'object'
      ? (call.rawInput as Record<string, unknown>)
      : {};
  for (const key of ['command', 'cmd', 'script', 'query', 'url', 'pattern']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return activityText(value, limit);
  }
  const paths = Array.isArray(call.locations)
    ? (call.locations as Array<{ path?: unknown }>)
        .map((location) => (typeof location.path === 'string' ? location.path : ''))
        .filter(Boolean)
    : [];
  const fromInput = ['path', 'file_path', 'filePath', 'abs_path'].flatMap((key) =>
    typeof input[key] === 'string' ? [input[key] as string] : [],
  );
  const named = [...new Set([...fromInput, ...paths])];
  const summary = named.length > 0 ? activityText(named.slice(0, 4).join(', '), limit) : '';
  // Several runtimes title an edit with the path ("Write /repo/a.ts"), and
  // repeating it under the name says nothing twice. The name is enough.
  return summary && toolName.includes(summary) ? '' : summary;
}

/** What an answer in chat could have meant. */
export type ApprovalMatch<T> =
  | { kind: 'one'; approval: T }
  /** Nothing is waiting, or what was named is not among what is. */
  | { kind: 'none' }
  /** More than one question could be meant; say which, do not guess. */
  | { kind: 'ambiguous'; candidates: T[] };

/**
 * Which open question a chat answer names.
 *
 * A bare "yes" answers the only open question and nothing else — with two
 * open, silence about which one is not consent to either. A name matches the
 * whole tool name, then the start of one, then a fragment; a `#handle`
 * matches the id. Anything that lands on more than one is ambiguous, and so
 * is a bare answer with more than one waiting.
 */
export function pickApproval<T extends { request: Pick<ApprovalRequest, 'toolName' | 'requestId'> }>(
  open: readonly T[],
  which: string,
): ApprovalMatch<T> {
  if (open.length === 0) return { kind: 'none' };
  const wanted = which.trim().toLowerCase().replace(/^#/, '');
  if (wanted.length === 0) {
    return open.length === 1 ? { kind: 'one', approval: open[0]! } : { kind: 'ambiguous', candidates: [...open] };
  }

  const byHandle = open.filter((entry) =>
    approvalHandle(entry.request.requestId).startsWith(wanted),
  );
  if (byHandle.length === 1) return { kind: 'one', approval: byHandle[0]! };
  if (byHandle.length > 1) return { kind: 'ambiguous', candidates: byHandle };

  const names = open.map((entry) => entry.request.toolName.toLowerCase());
  for (const test of [
    (name: string) => name === wanted,
    (name: string) => name.startsWith(wanted),
    (name: string) => name.includes(wanted),
  ]) {
    const hits = open.filter((_, index) => test(names[index]!));
    if (hits.length === 1) return { kind: 'one', approval: hits[0]! };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits };
  }
  // Named something, and it is not among what is waiting. Saying which are
  // is more use than silently taking the oldest, which is the old bug.
  return { kind: 'ambiguous', candidates: [...open] };
}

/** "Bash #a1b2c3 (git status)" — one line of the "which one?" reply. */
export function describeApproval(request: Pick<ApprovalRequest, 'toolName' | 'requestId' | 'summary'>): string {
  const handle = `${request.toolName} #${approvalHandle(request.requestId)}`;
  return request.summary ? `${handle} (${request.summary.slice(0, 60)})` : handle;
}

/**
 * The session mode that makes a runtime actually ask, per runtime.
 *
 * Found the hard way: `@agentclientprotocol/claude-agent-acp` 0.81 opens a
 * session in mode `auto` — "Claude handles permission decisions" — and so
 * never sends `session/request_permission` at all. Every approval path above
 * this line was therefore dead on the office's primary runtime, and an agent
 * *without* the `run` scope was getting the same silent self-approval as one
 * with it. The office's policy has to be the runtime's policy, or it is not a
 * policy.
 *
 * Deliberately a short allowlist rather than a guess. A mode id means what a
 * particular adapter says it means, and inferring "this one asks" from a name
 * would be exactly the unfounded claim QUIN-53 exists to stop. Runtimes not
 * named here keep whatever they open with, and the runner says so out loud.
 */
const ASKING_MODE: Readonly<Record<string, string>> = {
  // "Manual — Always ask before making changes". Verified against adapter
  // 0.81 end to end: the request arrives, the card appears, the answer lands.
  'claude-code': 'default',
};

/** What `session/new` says about modes, as much of it as we rely on. */
export interface SessionModes {
  currentModeId?: string;
  availableModes?: ReadonlyArray<{ id?: string; name?: string }>;
}

/**
 * The mode to switch this session to so the owner is asked, or null to leave
 * it alone — because we already ask, because this runtime is not one we have
 * established a mode for, or because it does not offer the mode we know.
 */
export function askingMode(harness: string, modes: SessionModes | undefined): string | null {
  const wanted = ASKING_MODE[harness];
  if (!wanted || !modes) return null;
  if (modes.currentModeId === wanted) return null;
  const offered = (modes.availableModes ?? []).some((mode) => mode.id === wanted);
  return offered ? wanted : null;
}

/** Whether we should warn that this runtime may never ask. */
export function mayNeverAsk(harness: string, modes: SessionModes | undefined): boolean {
  return ASKING_MODE[harness] === undefined && (modes?.availableModes?.length ?? 0) > 0;
}
