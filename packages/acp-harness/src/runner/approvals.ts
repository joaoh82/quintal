import type { ApprovalOption, ApprovalRequest } from '@quintal/shared';
import { activityText } from '@quintal/shared';

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

/** What the owner said, or what silence means. */
export type PermissionDecision = 'once' | 'always' | 'deny';

/** One question the runtime is holding a tool on. */
export interface PendingApproval {
  /** What is published and answered by. The identity of this ask. */
  request: ApprovalRequest;
  /** `worker:toolCallId` — how a crash or a cancel finds its questions. */
  callId: string;
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

/**
 * Which runtime options we can honestly put on a card.
 *
 * Only what this request actually offered, and only the two whose breadth we
 * can explain. A standing grant's real lifetime differs per runtime and is
 * QUIN-53's to establish; until then no button claims one. A runtime that
 * offers no reject option still gets a Deny — every ACP agent must accept a
 * cancelled outcome, which is a refusal by another name.
 */
export function supportedOptions(
  options: ReadonlyArray<{ optionId?: string; kind?: string; name?: string }>,
): ApprovalOption[] {
  const allow = options.some((option) => option.kind?.startsWith('allow'));
  return [
    ...(allow ? [{ id: 'allow_once' as const, label: 'Allow once' }] : []),
    { id: 'deny' as const, label: 'Deny' },
  ];
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
