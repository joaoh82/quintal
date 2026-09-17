# QUIN-50 verification

## Scope and environment

Implementation and checks ran in the `latency-phase-metrics` worktree, based on
freshly updated main `da2b5d5` (later than the ticket's planning baseline
`ac66109`). Verification was approved by the user before execution.
The local production office used port **3050**, disposable SQLite/storage under
`/tmp/quin50-verification`, and disposable identities. Port 3000 was untouched.
Runtime fixtures used a separate checkout at `da2b5d5`. No production office
messages, credentials, private runtime content or raw tool results are attached.

The selected runtime is Codex ACP **1.12.0** with installed Codex **0.154.0**, model **gpt-6-astra**, existing
medium reasoning, parallelism **2**, macOS 26.5.2 (Darwin 25.5.0) / Node 24.13.0 on an Apple M1 Pro
(10 cores, 32 GiB RAM). The browser reported Chromium 152; viewport 2560×1295.
No model/provider or process ceiling changed. The harness artifacts include the
observed adapter version, environment and source hash. Provider model build,
queue, prefill and generation timings are not exposed. This is a developer
laptop measurement, not an isolated production benchmark; initial baseline
runs overlapped local build/test work and fixture browser checks.

Commit messages were later rewritten solely to add required DCO sign-offs.
Artifacts retain their original measured revisions and implementation hashes:
`e75ce37` → `ff0fa77`, `3339e7e` → `dfb8a91`, `1ac1607` → `f412794`, and
`f59b931` → `fc508d7`. Each pair has an identical source tree.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass: shared, harness, web, server |
| Shared suite | Pass: 393 tests |
| Server suite | Pass: 95 tests |
| Web suite | Pass: 168 tests |
| Harness suite | Pass: 234 tests; final focused diagnostics 9/9, including async observer failure |
| Client manifest check | Pass: 22 boundaries, 23 route manifests |
| `git diff --check` | Pass |

Suite command: `pnpm --filter @quintal/shared --filter @quintal/server --filter
@quintal/web --filter quintal-acp test`. No lint script is provided. Release
packaging and native desktop builds were not touched and were not rerun.
Initial checks found an incomplete gateway fixture type, a retry constructor
spread that overwrote the attempt number, and report metric index inference;
all were corrected and the relevant checks rerun. The final focused report
check covers browser-clock joins, async sink failures and retry labels, and
refuses unverified first answers. A final browser-only probe confirms that two
turns sharing a human ID yield `outcome: ambiguous`, `deliveryMs: null` and
`answerCandidateMs: null` ([evidence](browser/observer-ambiguity.json)). This
conservative guard was added after the comparison; none of its 120 requests
had multiple turns. The saved observer hash identifies the measured version.

Selected command output is retained in [check evidence](checks.txt).

## Smoke checks

- HTTP: `node scripts/smoke.mjs http://127.0.0.1:3050` passed all 12 public,
  signed-login, redirect, office and settings checks. The initial production
  start required a disposable auth secret; it passed after configuring one.
- Database/gateway: migrations applied to the disposable database. The existing
  activity protocol smoke passed: 17 snapshots, zero cross-channel leaks and
  zero agent wakeups. [Protocol evidence](protocol-report.json) includes
  completed/cancelled/disconnected rows and restricted history returning
  `{"code":"unauthorised","message":"Not a channel you are in."}`.
- Correlation: `pnpm exec tsx apps/server/scripts/smoke-latency.mts
  http://127.0.0.1:3050 PRIVATE_SEED` returned
  `{"pass":true,"forwarded":3,"validUuidPreserved":true,"invalidDiscarded":true,"legacySendAccepted":true}`.
- Approval: the [fixture traces](browser/approval.json) recorded a 44,411 ms
  human wait separately from 377 ms runtime excluding approval. An unaddressed
  `yes Bash` queued a second turn under the existing owner-command rules;
  explicit `@Probe Alpha yes Bash` completed both. The early screenshot also
  captured the pre-fix off-screen permission request.
  Browser timings for this early smoke are excluded because the observer's
  visibility check was subsequently corrected. A final post-fix smoke visibly
  rendered the [waiting request](browser/approval-after-waiting.png) and
  [completed reply](browser/approval-after-complete.png). Its
  [trace](browser/approval-after-fix.json) separates **198,563 ms human wait**
  from **221 ms runtime excluding approval**. This is one functional fixture
  check, not a performance cohort.
- Browser: bounded observations join human UUIDs to harness records and durable
  activity rows. The [corrected bottom-positioned fixture](browser/fixture-bottom.json)
  has 30/30 terminal states, 30 harness matches and 30 persisted rows; visible
  feedback p95 is 270 ms and terminal-state delivery p95 374 ms with a 200 ms
  injected runtime delay. Only 29 answers were visible within the collection
  window; this run **does not pass a first-answer comparison**. It measures
  transport/UI with a fake runtime, not real-model performance.
  [Screenshot](browser/fixture-bottom.png).

## Failed and excluded browser attempts

All attempts remain attached. The [burst pilot](browser/burst-pilot.json) hit
existing human message rate limits; batched correlation also needed a bounded
list of request IDs. The [initial paced pilot](browser/invalid-visibility-pilot.json)
was invalidated because the observer did not account for ancestor clipping and
an overlaid compact transcript. The corrected observer checks both and listens
for scroll/visibility changes. An [unpinned transcript pilot](browser/unpinned-transcript-pilot.json)
observed only 14/30 terminal states: later replies were mounted off-screen.
The bottom-positioned cohort scrolls before each send and still records its one
missing visible answer. The [real-model diagnostic pilot](browser/real-dom.json)
had 7/10 visible successes with a 30-second observation window; it identified
the resize defect but used a different protocol from the fixed comparison.
Missing observations are not zero-duration successes.

## Measured change and before/after

The selected Quintal-side fix is in `Transcript.tsx`. Mounting the working row
shrinks the transcript viewport from 660 to 630 pixels. A scroll event can then
see a 24-pixel bottom gap and clear the existing `< 24` bottom-following flag,
although the reader did not scroll. Later answers remain off-screen. The
[diagnostic trace](browser/scroll-diagnostic.json) records that transition.
The layout effect now follows the bottom on every commit while the reader is
still pinned, including commits that resize the viewport without changing the
message array. Intentional scrollback is preserved: [smoke evidence](browser/scrollback.json)
records scrollTop **5931 before and after** a new reply completed.

The real-model browser workload was fixed at **60 sequential warm greetings**
after one warm-up with a fresh runner, before and after. Model, runtime,
parallelism, prompt, foreground viewport and pacing were held fixed. Each send
starts at the transcript bottom after a 500 ms settling interval, with a
10-second visible-answer deadline. The runtime must settle before the next
request. The [exact workload](browser-workload.mjs), [before samples](browser/baseline-real.json),
[after samples](browser/after-real.json) and [comparison](browser-comparison.json)
are attached. No raw answer text is retained: the final public message is checked
for a short greeting and only the result is stored.

| Browser measure | Before p50 / p95 | After p50 / p95 | Fixed p95 budget |
| --- | ---: | ---: | ---: |
| Visible feedback | 131.9 / 2442.0 ms | 118.7 / 147.6 ms | 500 ms — pass |
| Verified first answer, observed requests only | 2099.6 / 3522.4 ms (44) | 2099.5 / 4011.1 ms (60) | 6506 ms — pass |
| Visible terminal state | 2220.6 / 3801.5 ms | 2414.9 / 4132.2 ms | 6506 ms — pass |
| Visible-answer deadline misses | 16 / 60 | 0 / 60 | Zero after — pass |

**Visible-feedback p95 fell 94%.** The before first-answer percentile excludes
16 missing observations and is not a complete-population latency claim. Since
more than 5% missed the 10-second deadline, its all-attempt p95 is **at least
10 seconds**; after the fix it is **4.01 seconds**, with all 60 observed.
Runtime completion succeeded for all 60 requests in each run. Its p95 changed
from 3652.6 to 4103.2 ms; the UI fix does not make the model faster. Median
verified-answer latency stayed essentially unchanged. The browser comparison
passes with at least 30 successful observations on both sides and no missing
after metrics. [After screenshot](browser/after60.png).

The separate [warm runtime comparison](warm-comparison.json) passes all five
fixed guards with 30/30 successes on each side: completion p95 4604.3 → 2674.0 ms;
queue 0.482 → 0.597 ms; context 0.095 → 0.125 ms; feedback dispatch 0.366 → 0.487 ms.
The runtime reduction is repeat-run variation, not an effect attributed to the
transcript change.

The [parallel-DM comparison](concurrent-dm-comparison.json) also passes all five
guards with 30/30 DM successes per run while 30 long reviews run in the channel.
DM completion p95 is 4675.0 → 2477.0 ms, first public reply dispatch
3051.9 → 2309.1 ms, and queue 0.223 → 0.136 ms. Channel review times are not pooled
with the short DM. The configured two-worker limit is unchanged.

## Runtime phase matrix

All values below are milliseconds; percentiles use nearest rank. Each row is
separate by prompt, cohort and conversation role. All runtime rows use Codex ACP
1.12.0, gpt-6-astra, parallelism 2 and the environment above. Cold means a new
conversation session after runner startup; boot before human send is excluded.
Controlled gateway feedback/reply are **dispatch**, not visible feedback or an
answer-quality claim. Visible first answer/delivery remain unavailable here;
the browser comparison above supplies those observations for warm DM greetings.

| Baseline cohort / prompt / role | Success / attempts | Timeout / setup failure | Feedback dispatch p50 / p95 | First public dispatch p50 / p95 | Completion p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| [cold / commands](runtime/baseline-cold-commands.json) | 30 / 30 | 0 / 0 | 0.06 / 0.51 | 4,733.18 / 5,777.13 | 13,230.62 / 15,302.92 |
| [cold / greeting](runtime/baseline-cold-greeting.json) | 30 / 30 | 0 / 0 | 0.06 / 0.14 | 4,964.77 / 7,709.74 | 5,106.17 / 7,871.90 |
| [cold / review](runtime/baseline-cold-review.json) | 30 / 30 | 0 / 0 | 0.06 / 0.17 | 4,765.49 / 6,062.71 | 49,535.22 / 57,595.76 |
| [cold / workspace](runtime/baseline-cold-workspace.json) | 30 / 30 | 0 / 0 | 0.08 / 0.42 | 4,712.41 / 6,191.60 | 13,064.17 / 15,148.66 |
| [concurrent / review / channel](runtime/baseline-concurrent-greeting.json) | 30 / 30 | 0 / 0 | 0.15 / 0.48 | 2,154.00 / 4,763.99 | 12,341.29 / 15,870.08 |
| [concurrent / greeting / dm](runtime/baseline-concurrent-greeting.json) | 30 / 30 | 0 / 0 | 0.03 / 0.11 | 1,990.70 / 3,051.87 | 2,105.66 / 4,675.03 |
| [reconnect / greeting](runtime/baseline-reconnect-greeting.json) | 30 / 30 | 0 / 0 | 0.13 / 0.70 | 1,784.52 / 3,566.83 | 1,949.51 / 4,253.80 |
| [saturation / review / channel](runtime/baseline-saturation-greeting.json) | 30 / 30 | 0 / 0 | 0.16 / 0.50 | 2,162.98 / 6,187.30 | 12,356.93 / 19,961.56 |
| [saturation / greeting / dm](runtime/baseline-saturation-greeting.json) | 60 / 60 | 0 / 0 | 0.03 / 0.09 | 3,603.81 / 6,558.34 | 3,832.19 / 7,430.09 |
| [warm / commands](runtime/baseline-warm-commands.json) | 30 / 30 | 0 / 0 | 0.10 / 0.51 | 2,019.65 / 4,478.50 | 8,366.15 / 11,225.26 |
| [warm / greeting](runtime/baseline-warm-greeting.json) | 30 / 30 | 0 / 0 | 0.14 / 0.37 | 1,822.36 / 4,465.07 | 2,045.71 / 4,604.34 |
| [warm / review](runtime/baseline-warm-review.json) | 30 / 30 | 0 / 0 | 0.15 / 1.86 | 2,244.33 / 5,183.75 | 13,172.89 / 16,120.20 |
| [warm / workspace](runtime/baseline-warm-workspace.json) | 30 / 30 | 0 / 0 | 0.15 / 0.59 | 2,322.33 / 3,400.13 | 7,215.26 / 11,092.28 |

Phase p95s overlap and must not be added. Runtime includes tool calls. Approval
was automatically granted in these read-only runtime fixtures (0 ms); the
separate office smoke above verifies real human-wait accounting. Outbound is
last observed dispatch after runtime, not server acknowledgement or paint.
Tool statistics count observed spans, not prompt expectations.

| Baseline cohort | Queue | Startup | Context | Runtime excluding approval | Tool spans n / p95 | Approval | Outbound after runtime |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold / commands | 0.70 | 737.75 | 0.67 | 14,794.93 | 90 / 3.41 | 0.00 | 0.51 |
| cold / greeting | 0.17 | 913.40 | 0.28 | 7,398.36 | 0 / unavailable | 0.00 | 0.28 |
| cold / review | 0.24 | 744.66 | 1.13 | 57,114.36 | 235 / 7.45 | 0.00 | 0.39 |
| cold / workspace | 0.49 | 928.60 | 1.95 | 14,489.13 | 46 / 2.98 | 0.00 | 0.38 |
| concurrent / review / channel | 1.86 | 0.79 | 0.27 | 15,867.73 | 7 / 7.02 | 0.00 | 0.19 |
| concurrent / greeting / dm | 0.22 | 0.70 | 0.07 | 4,674.81 | 0 / unavailable | 0.00 | 0.18 |
| reconnect / greeting | 1.40 | 0.33 | 0.10 | 4,253.31 | 0 / unavailable | 0.00 | 0.11 |
| saturation / review / channel | 0.96 | 0.65 | 0.74 | 19,960.21 | 8 / 7.35 | 0.00 | 0.24 |
| saturation / greeting / dm | 3,480.07 | 1.19 | 0.09 | 4,629.41 | 0 / unavailable | 0.00 | 0.21 |
| warm / commands | 0.59 | 0.19 | 0.08 | 11,225.06 | 90 / 10.74 | 0.00 | 0.26 |
| warm / greeting | 0.48 | 0.20 | 0.09 | 4,604.05 | 0 / unavailable | 0.00 | 0.09 |
| warm / review | 1.95 | 0.49 | 1.30 | 16,118.25 | 7 / 3.66 | 0.00 | 0.32 |
| warm / workspace | 0.70 | 2.62 | 0.68 | 11,091.94 | 31 / 43.58 | 0.00 | 0.33 |

**The dominant measured completion phase is the ACP runtime interval**, including
adapter orchestration and external model work. Provider queue, prefill and
generation are unavailable, so these results cannot attribute that interval to
a particular provider stage. Cold session setup is observable separately; pool
saturation also raises DM queue delay. Neither justifies changing the chosen
model or parallelism limit. The largest measured Quintal delivery defect was
the transcript resize losing bottom-following, fixed and compared above.

The reconnect cohort uses a controlled one-second gateway interruption; it does
not establish a real-network recovery SLA. Warm review sessions retain context,
so tool counts can differ substantially from fresh reviews. The concurrent and
saturation CLI mode is `greeting`, but its channel request is the fixed longer
review; those roles are separated above. Successful runtime completion does not
prove every complex reply's semantic correctness.

Only the selected UI workload and warm/parallel-DM guard cohorts were repeated
after the change. The full cold/warm prompt matrix, saturation and reconnect
characterize phase costs; no before/after improvement is claimed for them.
See [budgets](budget-rationale.md), fixed before repeats, and
[reproduction instructions](../../LATENCY.md).

## Recommended focused follow-ups

1. Attribute the dominant Codex ACP runtime interval with supported adapter/
   runtime telemetry while retaining the same model and reasoning setting. Warm
   greetings contain no tools or approval wait; the observed interval still
   cannot identify provider queue, prefill or generation. Do not guess a pool
   or model change from it.
2. Add a repeatable browser integration suite for streaming transcript resize,
   deliberate scrollback and conversation switching. The measured resize defect
   is fixed here; retain clipping/overlay checks so mounted DOM cannot masquerade
   as visible delivery.

Full local logs remain in `/tmp/quin50-verification`. Credential-bearing seed,
config and identity files are intentionally excluded from the repository.
