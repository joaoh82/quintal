/** Real AgentRunner + selected ACP runtime; controlled gateway, never a production office. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { platform, arch, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentReadyPayload, ChannelRef } from '@quintal/shared';
import type { AgentConfig } from '../src/config.js';
import type { Gateway, GatewayEvents } from '../src/gateway/client.js';
import type { LatencySample } from '../src/runner/latency.js';
import type { LatencyRun } from '../src/runner/latency-report.js';
const builtEntry = '../dist/index.js';
const { AgentRunner, summarizeLatency } = await import(builtEntry) as typeof import('../src/index.js');

const prompts = {
  greeting: 'Hello. Reply with a short greeting.',
  workspace: 'What repository is your current working directory? Read README.md and describe its purpose in two sentences. Do not edit files.',
  commands: 'Run exactly these three commands separately: ls; uname -a; false. Report each outcome, including the expected failure. Do not edit files.',
  review: 'Perform a read-only review of packages/acp-harness/src/runner/AgentRunner.ts, worker.ts, pool.ts and sessions.ts. Read the files. Identify the three most significant correctness or performance concerns with file references. Do not edit files or run tests.',
} as const;
const cohorts = ['cold', 'warm', 'concurrent', 'saturation', 'reconnect'] as const;
type Cohort = typeof cohorts[number];
const [configPath, outputPath, cohortArg = 'warm', promptArg = 'greeting', label = 'baseline'] = process.argv.slice(2);
if (!configPath || !outputPath || !cohorts.includes(cohortArg as Cohort) || !Object.hasOwn(prompts, promptArg) || !['baseline', 'after'].includes(label)) {
  throw new Error('Usage: tsx measure-latency.ts CONFIG OUTPUT cold|warm|concurrent|saturation|reconnect greeting|workspace|commands|review baseline|after');
}
const config = JSON.parse(readFileSync(configPath, 'utf8')) as AgentConfig;
if (!config.modelId || !config.command?.length || !config.cwd || !config.harness ||
    !Number.isInteger(config.parallelism) || config.parallelism! < 1 || config.parallelism! > 32) {
  throw new Error('Config must explicitly specify modelId, command, cwd, harness and parallelism (1–32). No model or pool default is inferred.');
}
const cohort = cohortArg as Cohort;
if ((cohort === 'concurrent' || cohort === 'saturation') && config.parallelism! < 2) {
  throw new Error('Concurrent responsiveness requires an already-selected parallelism >= 2; do not change it between runs.');
}
const count = 30;
const timeoutMs = 300_000;
const samples = new Map<string, LatencySample>();
let attempted = 0;
const attemptedByConversation = { channel: 0, dm: 0, spatial: 0 };
let timedOut = 0;
let setupFailures = 0;
let collecting = false;
let sequence = 0;
const channel = (kind: 'channel' | 'dm'): ChannelRef => {
  const id = `latency-${++sequence}`;
  return { id, kind, name: 'Latency fixture', slug: kind === 'dm' ? '' : id } as ChannelRef;
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeout = timeoutMs): Promise<boolean> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

function fixture() {
  const handlers: Partial<GatewayEvents> = {};
  let connected = true;
  const lobby = channel('channel');
  const dms = Array.from({ length: config.parallelism! }, () => channel('dm'));
  const ready = {
    agentId: 'latency-agent', name: 'LatencyAgent', ownerUserId: 'latency-human',
    ownerName: 'Fixture', description: '', instructions: '', scopes: ['chat', 'status', 'run'],
    channels: [lobby, ...dms], limits: { parallelism: config.parallelism }, activityVersion: 1,
  } as unknown as AgentReadyPayload;
  const finished = new Set<string>();
  const gateway: Gateway = {
    ready, roster: null,
    get connected() { return connected; },
    connect: async () => { connected = true; handlers.ready?.(ready); return ready; },
    leave: async () => { connected = false; },
    on: (event, handler) => { Object.assign(handlers, { [event]: handler }); },
    activity: () => {},
    say: () => {}, setStatus: () => {}, emote: () => {}, hostReport: () => {},
    moveToZone: () => {}, moveToPerson: () => {},
    lookAround: async () => ({ zone: null, tile: { x: 0, y: 0 }, occupants: [] }),
    messagesGet: async () => ({ scope: 'nearby', zoneId: null, channelId: null, messages: [], hasMore: false }),
    memoryGet: async () => ({ slug: 'core', content: '', hash: 'fixture' }) as Awaited<ReturnType<Gateway['memoryGet']>>,
    memorySet: async () => { throw new Error('Read-only latency fixture'); },
    occupants: () => [], channels: () => [lobby, ...dms],
  };
  const runner = new AgentRunner({ ...config, name: 'LatencyAgent' }, undefined, gateway);
  runner.on('latency', sample => {
    if (sample.outcome !== 'retry') finished.add(sample.requestId);
    if (collecting) samples.set(`${sample.requestId}:${sample.attempt}`, sample);
  });
  function send(target: ChannelRef, text: string) {
    // The synthetic human and harness share a clock; transport/DOM is deliberately absent.
    handlers.channelChat?.({ channel: target, from: 'fixture-human', fromUserId: 'latency-human',
      fromName: 'Fixture', fromKind: 'human', text, sentAt: Date.now(), mentioned: true });
  }
  return { runner, send, lobby, dms, completions: () => finished.size, disconnect: () => {
    connected = false;
    handlers.closed?.(1006);
  }, connected: () => connected };
}

function terminalCount(): number {
  return new Set([...samples.values()].filter(s => s.outcome !== 'retry').map(s => s.requestId)).size;
}
const run: LatencyRun = {
  version: 1, label, cohort, prompt: promptArg, runtime: config.harness, model: config.modelId,
  parallelism: config.parallelism!, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  implementationHash: createHash('sha256').update([
    '../src/runner/AgentRunner.ts', '../src/runner/worker.ts', '../src/runner/pool.ts',
    '../src/runner/sessions.ts', '../src/runner/latency.ts', '../src/runner/latency-report.ts',
    './measure-latency.ts',
  ].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')).digest('hex'),
  environment: `${platform()} ${arch()} ${release()} Node ${process.version}`,
  transport: 'controlled-local-gateway', attempted: 0, timedOut: 0, samples: [],
};
let current: ReturnType<typeof fixture> | undefined;
try {
  for (let i = 0; i < count; i++) {
    collecting = false;
    const needsWarmup = !current;
    if (!current || cohort === 'cold') {
      await current?.runner.stop();
      current = fixture();
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([current.runner.start(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Runtime startup deadline')), timeoutMs);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      } catch { setupFailures++; break; }
    }
    const target = cohort === 'cold' ? channel('channel') : current.lobby;
    if (needsWarmup && cohort !== 'cold') {
      const warmupBefore = current.completions();
      current.send(target, prompts.greeting);
      const warmupWidth = cohort === 'concurrent' || cohort === 'saturation' ? 2 : 1;
      if (warmupWidth === 2) current.send(current.dms[0]!, prompts.greeting);
      if (!await waitFor(() => current!.completions() >= warmupBefore + warmupWidth)) { setupFailures++; break; }
    }
    collecting = true;
    const before = terminalCount();
    const width = cohort === 'saturation' ? config.parallelism! + 1 : cohort === 'concurrent' ? 2 : 1;
    attempted += width;
    attemptedByConversation.channel++;
    attemptedByConversation.dm += width - 1;
    current.send(target, cohort === 'concurrent' || cohort === 'saturation' ? prompts.review : prompts[promptArg as keyof typeof prompts]);
    for (let j = 1; j < width; j++) current.send(current.dms[j - 1]!, prompts.greeting);
    if (cohort === 'reconnect') current.disconnect();
    if (!await waitFor(() => terminalCount() >= before + width && (cohort !== 'reconnect' || current!.connected()))) {
      timedOut += Math.max(0, width - (terminalCount() - before));
      await current.runner.stop();
      current = undefined;
    }
    // Preserve terminal publication before advancing or closing the runtime.
    await sleep(150);
    writeFileSync(outputPath + '.checkpoint', JSON.stringify({ ...run, attempted, timedOut, samples: [...samples.values()] }) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ iteration: i + 1, observed: terminalCount(), attempted, timedOut }) + '\n');
  }
} finally {
  await current?.runner.stop();
  run.attempted = attempted;
  run.timedOut = timedOut;
  run.samples = [...samples.values()];
  const summary = summarizeLatency(run);
  // Split simultaneous requests by role. Never pool the long review with the short DM.
  const byConversation = Object.fromEntries((['channel', 'dm', 'spatial'] as const).map(conversation => [conversation,
    summarizeLatency({ ...run, attempted: attemptedByConversation[conversation],
      samples: run.samples.filter(s => s.conversation === conversation) })]));
  writeFileSync(outputPath, JSON.stringify({ run, summary, byConversation, setupFailures,
    limitations: ['Controlled gateway: excludes human socket ingress, office persistence/fan-out and browser render.',
      'Cold means a fresh conversation session after runner.start; boot before a human can send is excluded.',
      'Approval grants are automatic in this read-only fixture; real human approval needs a separate office cohort.',
      'No raw runtime errors, prompts, tool arguments/results or private activity snapshots are retained.'] }, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ successful: summary.successful, attempted, timedOut, setupFailures }) + '\n');
  if (setupFailures || !summary.comparable || timedOut) process.exitCode = 1;
}
