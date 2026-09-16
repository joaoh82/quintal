/** Public, replayable activity. Never contains ACP thoughts or arbitrary raw payloads. */
export type ActivityState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'writing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'disconnected';
export type StepState =
  'pending' | 'running' | 'success' | 'failed' | 'unknown' | 'cancelled' | 'interrupted';
export interface ActivityItem {
  id: string;
  kind: 'message' | 'tool';
  text: string;
  state: StepState;
  startedAt: number;
  endedAt?: number;
  detail?: string;
}
export interface AgentActivity {
  version: 1;
  turnId: string;
  workerId: string;
  sessionId: string;
  requestId: string;
  sequence: number;
  channelId?: string;
  zoneId?: string;
  state: ActivityState;
  startedAt: number;
  updatedAt: number;
  items: ActivityItem[];
}
export interface PublicActivity extends AgentActivity {
  agentId: string;
  agentName: string;
  /** Server receive time, also usable for measuring delivery latency. */
  receivedAt: number;
  /** Delivery hint, never persisted: also audible in the nearby transcript. */
  nearby?: boolean;
}
export const ACTIVITY_INTERVAL_MS = 100;
export const ACTIVITY_MAX_ITEMS = 64;
export const ACTIVITY_MAX_TEXT = 16_000;
export const ACTIVITY_MAX_BYTES = 64_000;
export function activityTerminal(state: ActivityState): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'disconnected'].includes(state);
}
/** Plain text only, with control sequences and common credentials removed. */
export function activityText(value: unknown, limit = 2000): string {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, ACTIVITY_MAX_BYTES)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/(--(?:api-key|token|password|secret)\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]')
    .replace(/\b(?:nsec1|qa_|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(
      /((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi,
      '$1[redacted]',
    )
    .slice(0, limit);
}
const states: ActivityState[] = [
  'queued',
  'preparing',
  'running',
  'waiting',
  'writing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'disconnected',
];
const steps: StepState[] = [
  'pending',
  'running',
  'success',
  'failed',
  'unknown',
  'cancelled',
  'interrupted',
];
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w.:/-]{1,160}$/.test(v);
const timestamp = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** Rebuild the allowlisted shape at the trust boundary; do not spread client fields. */
export function parseActivity(value: unknown): AgentActivity | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as AgentActivity;
  if (
    v.version !== 1 ||
    !id(v.turnId) ||
    !id(v.workerId) ||
    !id(v.sessionId) ||
    !id(v.requestId) ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1 ||
    !states.includes(v.state) ||
    !timestamp(v.startedAt) ||
    !timestamp(v.updatedAt) ||
    !Array.isArray(v.items) ||
    v.items.length > ACTIVITY_MAX_ITEMS ||
    (v.channelId !== undefined && !id(v.channelId)) ||
    (v.zoneId !== undefined && !id(v.zoneId)) ||
    (v.channelId && v.zoneId)
  )
    return null;
  if (new TextEncoder().encode(JSON.stringify(value)).length > ACTIVITY_MAX_BYTES) return null;
  const items: ActivityItem[] = [];
  const seen = new Set<string>();
  for (const item of v.items) {
    if (
      !item ||
      !id(item.id) ||
      seen.has(item.id) ||
      !['message', 'tool'].includes(item.kind) ||
      !steps.includes(item.state) ||
      !timestamp(item.startedAt) ||
      (item.endedAt !== undefined && !timestamp(item.endedAt))
    )
      return null;
    seen.add(item.id);
    items.push({
      id: item.id,
      kind: item.kind,
      text: activityText(item.text, item.kind === 'message' ? ACTIVITY_MAX_TEXT : 240),
      state: item.state,
      startedAt: item.startedAt,
      ...(item.endedAt === undefined ? {} : { endedAt: item.endedAt }),
      ...(item.detail === undefined ? {} : { detail: activityText(item.detail, 2000) }),
    });
  }
  return {
    version: 1,
    turnId: v.turnId,
    workerId: v.workerId,
    sessionId: v.sessionId,
    requestId: v.requestId,
    sequence: v.sequence,
    state: v.state,
    startedAt: v.startedAt,
    updatedAt: v.updatedAt,
    items,
    ...(v.channelId ? { channelId: v.channelId } : {}),
    ...(v.zoneId ? { zoneId: v.zoneId } : {}),
  };
}
export function mergeActivity(
  current: PublicActivity | undefined,
  next: PublicActivity,
): PublicActivity {
  return current &&
    (current.sequence > next.sequence ||
      (current.sequence === next.sequence && current.receivedAt >= next.receivedAt))
    ? current
    : next;
}
