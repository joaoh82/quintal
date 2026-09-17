import { latencyRequestId } from '@quintal/shared';
import { randomUUID } from 'node:crypto';

export type LatencyPhase =
  | 'claimed' | 'workerReady' | 'sessionReady' | 'contextReady' | 'promptDispatched'
  | 'runtimeCompleted' | 'feedbackDispatched' | 'replyDispatched' | 'lastOutboundDispatched';
export type LatencyOutcome = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'retry';

export interface LatencySample {
  version: 1;
  requestId: string;
  activityTurnId: string | null;
  attempt: number;
  /** Server timestamp for correlation only; never subtract clocks on different hosts. */
  serverSentAt: number;
  enqueuedAt: number;
  conversation: 'channel' | 'dm' | 'spatial';
  session: 'warm' | 'cold' | 'unclaimed';
  saturated: boolean;
  reconnected: boolean;
  worker: number | null;
  runtimeVersion: string | null;
  runtimeStop: 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests' | 'other' | null;
  phases: Partial<Record<LatencyPhase, number>>;
  approvalMs: number;
  tools: Array<{ ordinal: number; startMs: number | null; endMs: number | null }>;
  toolsTruncated: boolean;
  outcome: LatencyOutcome;
  finishedMs: number;
  unavailable: readonly string[];
}

/** One human trigger, even when several triggers share a prompt. All durations use one clock. */
export class LatencyTrace {
  readonly requestId: string;
  readonly origin: number;
  readonly sample: LatencySample;
  readonly #tools = new Map<string, LatencySample['tools'][number]>();
  #approvalDepth = 0;
  #approvalStart = 0;
  #finished = false;
  #activitySequence = 0;
  #terminalDispatched = false;

  constructor(
    input: Pick<LatencySample, 'serverSentAt' | 'conversation'> & { requestId?: string },
    private readonly emit: (sample: LatencySample) => void,
    private readonly now: () => number = () => performance.now(),
    previous?: LatencyTrace,
  ) {
    this.requestId = previous?.requestId ?? latencyRequestId(input.requestId) ?? randomUUID();
    this.origin = previous?.origin ?? now();
    this.sample = {
      version: 1, requestId: this.requestId, activityTurnId: null,
      attempt: previous ? previous.sample.attempt + 1 : 0,
      serverSentAt: input.serverSentAt, conversation: input.conversation, enqueuedAt: previous?.sample.enqueuedAt ?? Date.now(),
      session: 'unclaimed', saturated: previous?.sample.saturated ?? false,
      reconnected: previous?.sample.reconnected ?? false,
      worker: null, runtimeVersion: null, runtimeStop: null, phases: {}, approvalMs: 0,
      tools: [], toolsTruncated: false, outcome: 'failed', finishedMs: 0,
      unavailable: ['browserSend', 'visibleFeedback', 'visibleReply', 'deliveryAcknowledgement',
        'providerQueue', 'providerPrefill', 'providerGeneration'],
    };
  }

  elapsed(): number { return Math.max(0, this.now() - this.origin); }

  mark(phase: LatencyPhase): void {
    if (phase === 'lastOutboundDispatched') this.sample.phases[phase] = this.elapsed();
    else if (this.sample.phases[phase] === undefined) this.sample.phases[phase] = this.elapsed();
    else return;
    // Paced chat and reconnect replay may leave after the runtime has completed.
    if (this.#finished) this.#publish();
  }

  activity(sequence: number, reply: boolean, terminal: boolean): void {
    // A replay of already-dispatched progress is not another outbound delay.
    if (sequence <= this.#activitySequence || this.#terminalDispatched) return;
    this.#activitySequence = sequence;
    this.#terminalDispatched = terminal;
    this.mark('feedbackDispatched');
    if (reply) this.mark('replyDispatched');
    this.mark('lastOutboundDispatched');
  }

  tool(update: Record<string, unknown>, initial: boolean): void {
    const id = update.toolCallId;
    if (typeof id !== 'string') return;
    // IDs are lookup keys only and are never emitted; cap even malformed adapter IDs.
    if (id.length > 512) { this.sample.toolsTruncated = true; return; }
    let tool = this.#tools.get(id);
    if (!tool) {
      if (this.#tools.size >= 128) { this.sample.toolsTruncated = true; return; }
      tool = { ordinal: this.#tools.size, startMs: initial ? this.elapsed() : null, endMs: null };
      this.#tools.set(id, tool);
      this.sample.tools.push(tool);
    }
    if (update.status === 'completed' || update.status === 'failed') tool.endMs ??= this.elapsed();
  }

  approval(): () => void {
    if (this.#approvalDepth++ === 0) this.#approvalStart = this.elapsed();
    let released = false;
    return () => {
      if (released || this.#finished) return;
      released = true;
      if (--this.#approvalDepth === 0) this.sample.approvalMs += this.elapsed() - this.#approvalStart;
    };
  }

  finish(outcome: LatencyOutcome): void {
    if (this.#finished) return;
    if (this.#approvalDepth > 0) this.sample.approvalMs += this.elapsed() - this.#approvalStart;
    this.#finished = true;
    this.sample.outcome = outcome;
    this.sample.finishedMs = this.elapsed();
    this.#publish();
  }

  retry(): LatencyTrace {
    return new LatencyTrace(this.sample, this.emit, this.now, this);
  }

  #publish(): void {
    // Diagnostics must never fail a conversation. Consumers own storage/retention.
    try {
      const pending: unknown = this.emit(structuredClone(this.sample));
      if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch { /* observer failure */ }
  }
}

export function percentiles(values: number[]): { n: number; p50: number | null; p95: number | null } {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number): number | null => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95) };
}

/** Phases overlap (tools and approvals are inside runtime); never add their percentiles. */
export function latencyDurations(s: LatencySample): Record<string, number | null> {
  const p = s.phases;
  const span = (end: number | undefined, start: number | undefined): number | null =>
    end === undefined || start === undefined ? null : Math.max(0, end - start);
  const runtime = span(p.runtimeCompleted, p.promptDispatched);
  return {
    queue: p.claimed ?? null,
    startup: span(p.sessionReady, p.claimed),
    workerStartup: span(p.workerReady, p.claimed),
    sessionSetup: span(p.sessionReady, p.workerReady),
    context: span(p.contextReady, p.sessionReady),
    runtime: runtime,
    runtimeWithoutApproval: runtime === null ? null : Math.max(0, runtime - s.approvalMs),
    approval: s.approvalMs,
    feedbackDispatch: p.feedbackDispatched ?? null,
    firstReplyDispatch: p.replyDispatched ?? null,
    completion: p.runtimeCompleted ?? null,
    completionWithoutApproval: p.runtimeCompleted === undefined ? null : Math.max(0, p.runtimeCompleted - s.approvalMs),
    outboundAfterRuntime: span(p.lastOutboundDispatched, p.runtimeCompleted),
    visibleFeedback: null, firstAnswer: null, delivery: null,
  };
}
