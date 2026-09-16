import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LatencyTrace, latencyDurations, percentiles, type LatencySample } from '../src/runner/latency.js';
import { summarizeLatency, type LatencyRun } from '../src/runner/latency-report.js';

describe('latency diagnostics', () => {
  it('contains asynchronous observer failures', async () => {
    const trace = new LatencyTrace({ serverSentAt: 1, conversation: 'dm' }, async () => {
      throw new Error('diagnostic sink unavailable');
    });
    trace.finish('failed');
    await new Promise(resolve => setImmediate(resolve));
  });

  it('separates phases with one monotonic clock and unions overlapping approvals', () => {
    let now = 0;
    const records: LatencySample[] = [];
    const trace = new LatencyTrace({ serverSentAt: -99999, conversation: 'dm' }, s => records.push(s), () => now);
    now = 10; trace.mark('claimed');
    now = 20; trace.mark('workerReady');
    now = 30; trace.mark('sessionReady');
    now = 40; trace.mark('contextReady'); trace.mark('promptDispatched');
    now = 50; const first = trace.approval();
    now = 60; const second = trace.approval();
    now = 70; first(); first();
    now = 80; second();
    now = 100; trace.mark('runtimeCompleted'); trace.finish('completed');
    assert.equal(records[0]?.approvalMs, 30);
    assert.equal(latencyDurations(records[0]!).runtimeWithoutApproval, 30);
    assert.equal(latencyDurations(records[0]!).queue, 10);
    assert.equal(latencyDurations(records[0]!).visibleFeedback, null);
    now = 120; trace.mark('replyDispatched'); trace.mark('lastOutboundDispatched');
    assert.equal(latencyDurations(records.at(-1)!).outboundAfterRuntime, 20);
  });

  it('bounds tools without emitting IDs, inputs or private output; missing starts stay missing', () => {
    const trace = new LatencyTrace({ serverSentAt: 1, conversation: 'channel' }, () => {});
    trace.tool({ toolCallId: 'secret', status: 'completed', rawOutput: 'password' }, false);
    for (let i = 0; i < 200; i++) trace.tool({ toolCallId: String(i), rawInput: 'private' }, true);
    assert.equal(trace.sample.tools.length, 128);
    assert.equal(trace.sample.toolsTruncated, true);
    assert.equal(trace.sample.tools[0]?.startMs, null);
    assert.doesNotMatch(JSON.stringify(trace.sample), /secret|password|private/);
  });

  it('does not charge successful terminal replay as a new outbound delay', () => {
    let now = 10;
    const trace = new LatencyTrace({ serverSentAt: 1, conversation: 'dm' }, () => {}, () => now);
    now = 20; trace.activity(1, true, true);
    now = 5000; trace.activity(1, true, true); trace.activity(2, true, true);
    assert.equal(trace.sample.phases.lastOutboundDispatched, 10);
  });

  it('retains request identity and original queue origin on retry; observer failure is harmless', () => {
    let now = 0;
    const trace = new LatencyTrace({ serverSentAt: 1, conversation: 'dm' }, () => { throw new Error('sink'); }, () => now);
    trace.sample.saturated = true;
    trace.sample.reconnected = true;
    now = 100; trace.finish('retry');
    const retry = trace.retry();
    now = 120; retry.mark('claimed');
    assert.equal(retry.requestId, trace.requestId);
    assert.equal(retry.sample.attempt, 1);
    assert.equal(retry.sample.saturated, true);
    assert.equal(retry.sample.reconnected, true);
    assert.equal(retry.sample.phases.claimed, 120);
    retry.finish('failed');
  });

  it('does not hide missing samples, retries or failures behind successful percentiles', () => {
    const samples: LatencySample[] = [];
    for (let i = 0; i < 31; i++) {
      const trace = new LatencyTrace({ serverSentAt: i, conversation: 'dm' }, s => samples.push(s));
      if (i < 30) trace.mark('runtimeCompleted');
      trace.finish(i < 30 ? 'completed' : 'timeout');
    }
    const run: LatencyRun = {
      version: 1, label: 'baseline', cohort: 'warm', prompt: 'greeting', runtime: 'fixture',
      model: 'fixed', parallelism: 2, revision: 'test', environment: 'test',
      transport: 'controlled-local-gateway', attempted: 32, timedOut: 1, samples: [...samples, samples[0]!],
    };
    const report = summarizeLatency(run);
    assert.equal(report.observed, 31);
    assert.equal(report.successful, 30);
    assert.equal(report.missing, 1);
    assert.equal(report.outcomes.timeout, 1);
    assert.equal(report.comparable, false);
    assert.equal(report.metrics.firstAnswer?.unavailable, 30);
    assert.deepEqual(percentiles(Array.from({ length: 30 }, (_, i) => i + 1)), { n: 30, p50: 15, p95: 29 });
  });
});

describe('before/after comparison', () => {
  it('retains baseline delivery failures while allowing a fully observed repeat', async () => {
    const { compareLatency } = await import('../src/runner/latency-report.js');
    const samples: LatencySample[] = [];
    for (let i = 0; i < 31; i++) {
      const trace = new LatencyTrace({ serverSentAt: i, conversation: 'dm' }, s => samples.push(s));
      trace.mark('runtimeCompleted'); trace.finish('completed');
    }
    const before: LatencyRun = { version: 1, label: 'before', cohort: 'warm', prompt: 'greeting', runtime: 'fixture',
      model: 'fixed', parallelism: 2, revision: 'test', environment: 'test', transport: 'office',
      attempted: 31, timedOut: 0, samples, browser: samples.map((s, i) => ({ requestId: s.requestId,
        feedbackMs: 10, replyMs: i === 30 ? null : 20, deliveryMs: 30,
        answerCandidateMs: i === 30 ? null : 20, answerVerified: true,
        deadlineOutcome: i === 30 ? 'timeout-or-unverified' : 'success' })) };
    const after: LatencyRun = { ...before, label: 'after', browser: before.browser!.map(s => ({
      ...s, replyMs: 20, answerCandidateMs: 20, deadlineOutcome: 'success',
    })) };
    const comparison = compareLatency(before, after, { firstAnswer: 100 });
    assert.equal(comparison.pass, true);
    assert.equal(comparison.baseline.browserDeadlineFailures, 1);
    assert.equal(comparison.checks.firstAnswer?.baselineUnavailable, 1);
    assert.equal(compareLatency(after, before, { firstAnswer: 100 }).pass, false);
  });

  it('joins browser clocks by request ID and keeps unverified answers unavailable', () => {
    const samples: LatencySample[] = [];
    const trace = new LatencyTrace({ serverSentAt: 1, conversation: 'dm' }, s => samples.push(s));
    trace.mark('runtimeCompleted'); trace.finish('completed');
    const run: LatencyRun = { version: 1, label: 'before', cohort: 'warm', prompt: 'greeting', runtime: 'fixture',
      model: 'fixed', parallelism: 2, revision: 'test', environment: 'test', transport: 'office',
      attempted: 1, timedOut: 0, samples, browser: [{ requestId: trace.requestId, feedbackMs: 10,
        replyMs: 20, deliveryMs: 40, answerCandidateMs: 30 }] };
    const metrics = summarizeLatency(run).metrics;
    assert.equal(metrics.visibleFeedback?.p95, 10);
    assert.equal(metrics.firstPublicReply?.p95, 20);
    assert.equal(metrics.delivery?.p95, 40);
    assert.equal(metrics.firstAnswer?.p95, null);
    run.browser![0]!.answerVerified = true;
    assert.equal(summarizeLatency(run).metrics.firstAnswer?.p95, 30);
  });

  it('refuses an empty or undersampled comparison and mismatched models', async () => {
    const { compareLatency } = await import('../src/runner/latency-report.js');
    const run: LatencyRun = { version: 1, label: 'before', cohort: 'warm', prompt: 'greeting', runtime: 'fixture',
      model: 'fixed', parallelism: 2, revision: 'test', environment: 'test', transport: 'controlled-local-gateway',
      attempted: 0, timedOut: 0, samples: [] };
    assert.equal(compareLatency(run, run, {}).pass, false);
    assert.equal(compareLatency(run, run, { completion: 1000 }).pass, false);
    assert.deepEqual(compareLatency(run, { ...run, model: 'changed' }, { completion: 1000 }).mismatches, ['model']);
  });
});
