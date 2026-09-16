import { latencyDurations, percentiles, type LatencySample } from './latency.js';

export interface LatencyRun {
  version: 1;
  label: string;
  cohort: string;
  prompt: string;
  runtime: string;
  model: string | null;
  parallelism: number;
  revision: string;
  environment: string;
  implementationHash?: string;
  transport: 'controlled-local-gateway' | 'office';
  attempted: number;
  timedOut: number;
  samples: LatencySample[];
  browser?: Array<{
    requestId: string; feedbackMs: number | null; replyMs: number | null;
    deliveryMs: number | null; answerCandidateMs?: number | null;
    /** Only set after checking the final message answers the fixed prompt. */
    answerVerified?: boolean;
  }>;
}

export function summarizeLatency(run: LatencyRun) {
  // A late outbound dispatch replaces a completion snapshot, rather than creating a sample.
  const attempts = new Map<string, LatencySample>();
  for (const sample of run.samples) attempts.set(`${sample.requestId}:${sample.attempt}`, sample);
  const terminal = new Map<string, LatencySample>();
  for (const sample of attempts.values()) {
    const previous = terminal.get(sample.requestId);
    if (!previous || sample.attempt >= previous.attempt) terminal.set(sample.requestId, sample);
  }
  const successful = [...terminal.values()].filter(s => s.outcome === 'completed' && s.phases.runtimeCompleted !== undefined);
  const browser = new Map((run.browser ?? []).map(sample => [sample.requestId, sample]));
  const durations = successful.map<Record<string, number | null>>(sample => {
    const d = latencyDurations(sample);
    const observed = browser.get(sample.requestId);
    return { ...d, visibleFeedback: observed?.feedbackMs ?? null,
      firstPublicReply: observed?.replyMs ?? null,
      firstAnswer: observed?.answerVerified ? observed.answerCandidateMs ?? null : null,
      delivery: observed?.deliveryMs ?? null };
  });
  const metrics: Record<string, ReturnType<typeof percentiles> & { unavailable: number }> = {};
  for (const key of Object.keys({ ...latencyDurations({ phases: {}, approvalMs: 0 } as LatencySample), firstPublicReply: null, visibleFeedback: null, firstAnswer: null, delivery: null })) {
    const values = durations.map(d => d[key]).filter((v): v is number => typeof v === 'number');
    metrics[key] = { ...percentiles(values), unavailable: successful.length - values.length };
  }
  const outcomes: Record<string, number> = {};
  for (const sample of terminal.values()) outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
  const phases = ['queue', 'startup', 'context', 'runtimeWithoutApproval', 'outboundAfterRuntime'];
  const dominant = phases.filter(key => metrics[key]?.p95 !== null)
    .sort((a, b) => (metrics[b]?.p95 ?? 0) - (metrics[a]?.p95 ?? 0))[0] ?? null;
  const { samples: _, browser: _browser, ...metadata } = run;
  return {
    ...metadata, observed: terminal.size, successful: successful.length,
    missing: Math.max(0, run.attempted - terminal.size), outcomes,
    sessions: Object.fromEntries(['warm', 'cold', 'unclaimed'].map(kind => [kind, [...terminal.values()].filter(s => s.session === kind).length])),
    retryAttempts: [...attempts.values()].filter(s => s.outcome === 'retry').length,
    runtimeVersions: [...new Set([...terminal.values()].map(s => s.runtimeVersion))],
    comparable: successful.length >= 30 && run.attempted === terminal.size && run.model !== null,
    metrics, dominantObservedPhase: dominant,
    tools: {
      durations: percentiles(successful.flatMap(s => s.tools.flatMap(t =>
        t.startMs === null || t.endMs === null ? [] : [Math.max(0, t.endMs - t.startMs)]))),
      incomplete: successful.reduce((n, s) => n + s.tools.filter(t => t.startMs === null || t.endMs === null).length, 0),
      truncatedRequests: successful.filter(s => s.toolsTruncated).length,
    },
    note: 'Nearest-rank percentiles of successful requests. Failures and timeouts are reported separately. Dispatch is not visible delivery. Runtime contains tools; provider internals are unavailable.',
  };
}

export function compareLatency(before: LatencyRun, after: LatencyRun, budgets: Record<string, number>) {
  const baseline = summarizeLatency(before);
  const result = summarizeLatency(after);
  const mismatches = (['cohort', 'prompt', 'runtime', 'model', 'parallelism', 'environment', 'transport'] as const)
    .filter(key => before[key] !== after[key]);
  if (JSON.stringify(baseline.runtimeVersions) !== JSON.stringify(result.runtimeVersions)) mismatches.push('runtime');
  const checks = Object.fromEntries(Object.entries(budgets).map(([metric, budgetMs]) => {
    const b = baseline.metrics[metric];
    const a = result.metrics[metric];
    const sufficient = !!a && !!b && a.n >= 30 && b.n >= 30 &&
      a.n === result.successful && b.n === baseline.successful;
    return [metric, { budgetMs, baselineP95: b?.p95 ?? null, afterP95: a?.p95 ?? null,
      pass: sufficient && Number.isFinite(budgetMs) && budgetMs >= 0 && a.p95 !== null && a.p95 <= budgetMs }];
  }));
  return {
    baseline, after: result, mismatches, checks,
    pass: mismatches.length === 0 && baseline.comparable && result.comparable &&
      Object.keys(checks).length > 0 && Object.values(checks).every(check => check.pass) &&
      result.successful / result.attempted >= baseline.successful / baseline.attempted &&
      result.timedOut <= baseline.timedOut,
  };
}
