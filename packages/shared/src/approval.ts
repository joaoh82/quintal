import { activityText } from './activity.js';
import { latencyRequestId } from './latency.js';

/**
 * Tool approvals, as a contract rather than a sentence.
 *
 * The runtime asks "may I run this?"; until QUIN-52 the only way that reached
 * a human was a line of chat, and the only way back was a line of chat matched
 * against open questions by tool name. Two turns asking about `Bash` at the
 * same time could not be told apart, and a bare "yes" answered whichever was
 * oldest — which is to say, possibly the wrong one.
 *
 * So: every ask gets an identity of its own, minted by the harness, and every
 * answer names it. The card in the conversation carries that id; the office
 * routes by it and by nothing else. The text question stays for clients and
 * harnesses that predate this, and is documented as a fallback — but an
 * ambiguous text answer now asks for specificity instead of guessing.
 */

/**
 * What the owner may choose.
 *
 * Two options, deliberately. A standing grant's real breadth and lifetime
 * differ per runtime and are not yet established (QUIN-53), and a button
 * promising more authority than it can explain is worse than no button.
 */
export const APPROVAL_OPTIONS = ['allow_once', 'deny'] as const;
export type ApprovalOptionId = (typeof APPROVAL_OPTIONS)[number];

export interface ApprovalOption {
  id: ApprovalOptionId;
  /** What the button says. The harness writes it; the office does not invent one. */
  label: string;
}

/** How a request stopped waiting. */
export const APPROVAL_RESOLUTIONS = [
  'allowed',
  'denied',
  /** Silence ran out the deadline; the runtime was told no. */
  'expired',
  /** The turn was cancelled, or the agent shut down, before anybody answered. */
  'cancelled',
  /** The runtime died, or the socket did, while the question was open. */
  'interrupted',
  /** The `run` scope answered on the owner's behalf. Audited, never asked. */
  'auto_allowed',
] as const;
export type ApprovalResolution = (typeof APPROVAL_RESOLUTIONS)[number];

/** Who or what answered. */
export const APPROVAL_VIAS = ['card', 'text', 'timeout', 'run_scope', 'system'] as const;
export type ApprovalVia = (typeof APPROVAL_VIAS)[number];

/** The harness asking. Sent as `agent:approval_request`. */
export interface ApprovalRequest {
  version: 1;
  /**
   * The identity of this ask, minted by the harness and unique for the life
   * of the process. Not the runtime's tool-call id: those are per process and
   * two workers can mint the same one.
   */
  requestId: string;
  turnId: string;
  workerId: string;
  sessionId: string;
  /** The activity turn's correlation root, when there is one. See QUIN-49. */
  activityRequestId?: string;
  /** Where the turn is. Exactly one of these, as with activity. */
  channelId?: string;
  zoneId?: string;
  /** The tool, named the way the runtime names it. */
  toolName: string;
  /** One sanitized line about what it would do — usually the command. */
  summary: string;
  /** Only options the runtime actually offered, mapped to what we can honour. */
  options: ApprovalOption[];
  askedAt: number;
  /** ms since epoch. Silence past this denies; see the harness's own timer. */
  expiresAt: number;
}

/** The harness saying it stopped waiting. Sent as `agent:approval_resolved`. */
export interface ApprovalResolved {
  version: 1;
  requestId: string;
  turnId: string;
  resolution: ApprovalResolution;
  /** The option taken, when a person took one. */
  optionId?: ApprovalOptionId;
  via: ApprovalVia;
  resolvedAt: number;
}

/** What the office adds before a browser sees it. */
export interface PublicApprovalRequest extends ApprovalRequest {
  agentId: string;
  agentName: string;
  /** The only human who may answer. `users.id`, never a display name. */
  ownerUserId: string;
  ownerName: string;
  receivedAt: number;
  /**
   * Sent straight to the owner because they cannot read the conversation the
   * turn is in. Shown in the owner's own corner, not in a transcript.
   */
  private?: boolean;
}

export interface PublicApprovalResolved extends ApprovalResolved {
  agentId: string;
  agentName: string;
  /** Who clicked, when somebody did. For the card's "answered by" line. */
  decidedByName?: string;
  receivedAt: number;
}

/** A human answering a card. Sent as `approval_decide`. */
export interface ApprovalDecidePayload {
  requestId: string;
  optionId: ApprovalOptionId;
}

/** The office passing an authenticated answer to the agent that asked. */
export interface AgentApprovalDecisionEvent {
  requestId: string;
  optionId: ApprovalOptionId;
  /** The owner. The harness does not re-check this; the office already did. */
  decidedByUserId: string;
  decidedByName: string;
}

/** How long a card stays answerable. The harness's own timer is the authority. */
export const APPROVAL_TIMEOUT_MS = 300_000;
/** Grace past the deadline before the office expires a card the harness has not. */
export const APPROVAL_EXPIRY_GRACE_MS = 30_000;
/** How long a resolved card is kept so a late joiner sees why it stopped. */
export const APPROVAL_KEEP_RESOLVED_MS = 60_000;
/** Most questions one agent may have open at once. */
export const APPROVAL_MAX_PER_AGENT = 16;
/** Most questions one office tracks at once. */
export const APPROVAL_MAX_PER_ROOM = 256;
export const APPROVAL_MAX_TOOL_NAME = 120;
export const APPROVAL_MAX_SUMMARY = 400;

const id = (v: unknown): v is string => typeof v === 'string' && /^[\w.:/-]{1,160}$/.test(v);
const timestamp = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function options(value: unknown): ApprovalOption[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > APPROVAL_OPTIONS.length)
    return null;
  const seen = new Set<string>();
  const parsed: ApprovalOption[] = [];
  for (const option of value) {
    if (!option || typeof option !== 'object') return null;
    const { id: optionId, label } = option as ApprovalOption;
    if (!APPROVAL_OPTIONS.includes(optionId) || seen.has(optionId)) return null;
    seen.add(optionId);
    parsed.push({ id: optionId, label: activityText(label, 40) || defaultLabel(optionId) });
  }
  return parsed;
}

/** What a button says when a harness sent an empty label. */
export function defaultLabel(optionId: ApprovalOptionId): string {
  return optionId === 'allow_once' ? 'Allow once' : 'Deny';
}

/**
 * Rebuild the allowlisted shape at the trust boundary.
 *
 * Same rule as `parseActivity`: never spread what came in. A harness is only
 * as trusted as the key it holds, and the summary is a command line.
 */
export function parseApprovalRequest(value: unknown): ApprovalRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as ApprovalRequest;
  const parsedOptions = options(v.options);
  if (
    v.version !== 1 ||
    !id(v.requestId) ||
    !id(v.turnId) ||
    !id(v.workerId) ||
    !id(v.sessionId) ||
    (v.activityRequestId !== undefined && latencyRequestId(v.activityRequestId) === undefined) ||
    typeof v.toolName !== 'string' ||
    typeof v.summary !== 'string' ||
    !parsedOptions ||
    !timestamp(v.askedAt) ||
    !timestamp(v.expiresAt) ||
    v.expiresAt <= v.askedAt ||
    (v.channelId !== undefined && !id(v.channelId)) ||
    (v.zoneId !== undefined && !id(v.zoneId)) ||
    (v.channelId && v.zoneId)
  )
    return null;
  const toolName = activityText(v.toolName, APPROVAL_MAX_TOOL_NAME).trim();
  if (toolName.length === 0) return null;
  return {
    version: 1,
    requestId: v.requestId,
    turnId: v.turnId,
    workerId: v.workerId,
    sessionId: v.sessionId,
    ...(v.activityRequestId ? { activityRequestId: latencyRequestId(v.activityRequestId)! } : {}),
    toolName,
    summary: activityText(v.summary, APPROVAL_MAX_SUMMARY),
    options: parsedOptions,
    askedAt: v.askedAt,
    expiresAt: v.expiresAt,
    ...(v.channelId ? { channelId: v.channelId } : {}),
    ...(v.zoneId ? { zoneId: v.zoneId } : {}),
  };
}

export function parseApprovalResolved(value: unknown): ApprovalResolved | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as ApprovalResolved;
  if (
    v.version !== 1 ||
    !id(v.requestId) ||
    !id(v.turnId) ||
    !APPROVAL_RESOLUTIONS.includes(v.resolution) ||
    !APPROVAL_VIAS.includes(v.via) ||
    (v.optionId !== undefined && !APPROVAL_OPTIONS.includes(v.optionId)) ||
    !timestamp(v.resolvedAt)
  )
    return null;
  return {
    version: 1,
    requestId: v.requestId,
    turnId: v.turnId,
    resolution: v.resolution,
    ...(v.optionId ? { optionId: v.optionId } : {}),
    via: v.via,
    resolvedAt: v.resolvedAt,
  };
}

/** A browser's answer, checked before it is trusted to name anything. */
export function parseApprovalDecide(value: unknown): ApprovalDecidePayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as ApprovalDecidePayload;
  if (!id(v.requestId) || !APPROVAL_OPTIONS.includes(v.optionId)) return null;
  return { requestId: v.requestId, optionId: v.optionId };
}

/** A resolved request is history; only a waiting one has buttons that do anything. */
export function approvalPending(
  request: Pick<ApprovalRequest, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return now < request.expiresAt;
}

/** What the runtime was told, in a word, for the card and for the audit line. */
export function describeResolution(resolved: Pick<ApprovalResolved, 'resolution'>): string {
  switch (resolved.resolution) {
    case 'allowed':
      return 'Allowed once';
    case 'auto_allowed':
      return 'Allowed by the run scope';
    case 'denied':
      return 'Denied';
    case 'expired':
      return 'No answer in time — denied';
    case 'cancelled':
      return 'Cancelled before it was answered';
    case 'interrupted':
      return 'Interrupted before it was answered';
  }
}
