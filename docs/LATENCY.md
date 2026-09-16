# Conversation latency (QUIN-50)

This instrumentation measures Quintal's existing worker/session path. It does
not change the selected model, process ceiling, session reuse, prewarming,
priming, trigger batching or outbound pacing. Results and budgets are recorded in `verification/QUIN-50/`. Runtime timings
include the adapter and its external model calls; they do not identify provider
queueing or token generation costs.

## Collection and privacy

Subscribe to `AgentRunner.on('latency', sample => …)` before starting the runner.
Without a subscriber, no traces are allocated. The subscriber chooses storage
and retention. It must upsert by `(requestId, attempt)`: delayed outbound sends
and reconnect replay can update an already completed sample. Exceptions from
the subscriber are contained. Keep the callback fast; disk/network work should
be buffered outside the conversation loop.

Browser sends carry an optional random UUID. The server validates and forwards
it without using it for authorization or persistence identity. Older clients
remain supported; the harness generates a UUID when correlation is absent.
Each human trigger keeps its own ID when up to 20 triggers share a prompt.
Public activity carries a validated, deduplicated list capped at 20 IDs. The activity turn ID links to QUIN-49 progress. A pre-dispatch
retry keeps the request ID and original enqueue origin, increments the attempt
and records the failed attempt as `retry`. Cancelled/failed queued requests and
idle timeouts emit outcomes too. Agent-to-agent banter and memory commands are
excluded. Per-request tools are capped at 128, with an explicit truncation flag;
unknown starts/ends remain null. Raw tool IDs are never exported.

Only timing offsets, random correlation IDs, enums, booleans, worker index and
runtime version are exported. No human/agent names, channel names, paths,
prompts, private thoughts, tool inputs/results or credentials are included.
This is separate from `--log-dir`, whose existing audit records contain content;
do not enable that option for a content-free measurement run.

## What the clocks mean

All harness offsets use `performance.now()` relative to enqueue. `serverSentAt`
is a correlation timestamp only: server and laptop clocks are not assumed to
agree. Browser offsets use the independent client clock. Harness-only reports mark
visible timings unavailable; never subtract timestamps across clocks or
substitute harness dispatch for a visible browser result.

| Measurement | Boundary |
| --- | --- |
| Queue | Enqueue → pool claim; retries include the original wait |
| Worker startup | Claim → `worker.ready()` |
| Session setup | Worker ready → session ready, including selected-model application |
| Startup | Claim → session ready |
| Context | Session ready → assembled envelope and optional memory priming |
| Runtime | `session/prompt` dispatch → response; includes runtime orchestration and tools |
| Tool | First observed `tool_call` → terminal update; absent events stay unknown |
| Approval | Union of periods waiting on the human; overlapping requests counted once |
| Feedback dispatch | First progress snapshot or reply dispatched on a connected gateway |
| First reply dispatch | First nonempty public message snapshot or paced reply dispatched |
| Completion | Runtime response, with a separate approval-subtracted value |
| Outbound after runtime | Last observed dispatch minus runtime completion, floored at zero |

Tool spans overlap runtime and may overlap each other. Do not add these p95s.
Runtime minus approval is **not model generation time**. Provider queue,
prefill and generation are unavailable. A public message may be narration;
first answer quality must be checked by the benchmark observer. ACP notices and
private thought chunks are not counted as public replies.

## Reproducible runtime cohorts

`packages/acp-harness/scripts/measure-latency.ts` runs the real AgentRunner,
worker pool, session store, bridge and chosen installed ACP runtime with a
controlled local gateway. It measures the runtime path, not office transport,
persistence or browser rendering. Nothing is posted to a real office. The fixed
prompts live in the script and must be identical in before/after runs.

Supply a private JSON `AgentConfig` with explicit `harness`, `command`, `cwd`,
`modelId`, `parallelism`, `url`, `mapId`, `workspaceId`, `key`, and `name`. Use an
isolated checkout for `cwd`. Select the user's existing runtime/model; do not
substitute a cheaper/faster default. Normal ACP model refusal remains enforced.
The controlled gateway needs no real office credential; `key` can be empty.
Installed runtime authentication remains the runtime's responsibility.

After approval, from the repository root:

```sh
pnpm exec tsx packages/acp-harness/scripts/measure-latency.ts \
  /tmp/quin50-config.json /tmp/quin50-warm-greeting.json warm greeting baseline
```

Run greeting, workspace, commands and review individually for cold and warm
cohorts. Cold means a new conversation session after runner boot; warm excludes
one warm-up request. Run `concurrent greeting`, `saturation greeting` and
`reconnect greeting` separately. Concurrent sends a read-only review in a
channel plus a short greeting in a DM; saturation sends one more request than
the unchanged pool ceiling. Reconnect interrupts the controlled gateway during
the prompt and exercises existing replay/backoff. These are explicitly labelled
controlled reconnects, not evidence about real network recovery.

Each run attempts 30 iterations. Concurrent requests are separated by channel
and DM role in the report. Keep cold/warm, reconnect/saturation and prompt
variants separate; do not compare pooled mixes. Reports record environment,
git revision, runtime, observed adapter versions, selected model, parallelism,
attempted/observed/successful counts, retries, failures, cancellations, timeouts,
and nearest-rank p50/p95 with available/missing counts. A comparison needs at
least 30 successful samples per role and cohort. Failed runs remain in the
artifact; reruns do not erase them. An absent runtime version stays null.

## End-to-end acceptance and improvement gate

The controlled runner is only one part of acceptance. In a disposable local
office on a free port other than **3000**, a browser observer must record human
send, first visible feedback, first visible reply and terminal delivery on the
same client clock and join them to activity turn IDs. Capture at least 30
successful samples per compared cohort, plus all failures/timeouts. Verify that
the first reply actually answers the fixed prompt. Include a separate human
approval exercise. Record browser/server versions, machine/load and dirty diff
identity alongside the harness report. Do not infer missing browser timings.

After baseline approval and execution:

1. Identify the dominant observed p95 phase, using matched prompt/cohort/model
   and the per-role DM results. Inspect outliers and tool spans rather than
   attributing all runtime time to the provider.
2. Establish numerical budgets from that baseline before changing behavior:
   target the dominant Quintal phase and set explicit warm-short-question and
   concurrent-DM non-regression limits. Record the values and rationale.
3. Implement the smallest supported change, keeping model and parallelism
   fixed. If evidence only points to runtime/external cost, document that
   limitation and a supported configuration option or focused follow-up.
4. Rerun the identical sample matrix and publish raw bounded timing artifacts,
   budgets, before/after percentiles, failure counts and the acceptance verdict.

Until those steps and real delivery observations are complete, QUIN-50 remains
in progress. No fake runtime timings or earlier QUIN-49 transport timings count
as Quintal's baseline for this task.

## Browser observations and comparison

In a disposable office, load `scripts/observe-conversation-latency.js` through
DevTools before sending. The web client emits `quintal:human-send` with only a
UUID and monotonic timestamp. The observer joins that UUID to visible activity
DOM attributes at an animation frame. It retains at most 512 requests and 64
message timing entries per request, with an eviction counter and no chat text.
Read `window.quintalLatency.samples()` and call `.stop()` when finished.
This boundary is visible DOM, not a compositor paint or a network acknowledgement.
Keep the page foregrounded and the relevant conversation visible. The observer
checks ancestor clipping and overlays; a mounted row behind a dialog does not
count. `deliveryMs` is visible terminal state, not proof that its final answer
is on-screen. Record the scroll protocol and retain off-screen/missing replies. Respect the
existing human message rate limit; retain unobserved sends as failures/missing.

`replyMs` measures first public content, which may be narration. The final public
message identified by the terminal snapshot supplies `answerCandidateMs` only
if that message was visible; only set
`answerVerified: true` in a joined report after checking it answers the fixed
prompt. Unverified answers stay unavailable. Batched sends may share one answer.
Use `observe-office-latency.ts CONFIG SEED OUTPUT.jsonl` for matching harness
records in a seeded local office. Seed and configuration files contain credentials
and must never be attached to reports.

Compare two measurement artifacts against a fixed JSON object of millisecond
budgets, using `report-latency.ts BEFORE AFTER BUDGETS`. Comparisons reject
mismatched cohorts, prompts, runtime versions, models, parallelism, environments
or transports; require 30 observations for each budgeted metric; and reject a
lower success rate or increased timeout count. A missing browser metric cannot
pass an end-to-end budget. Raw bounded timing artifacts retain failed attempts.
