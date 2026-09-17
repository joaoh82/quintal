# Budget fixed before the repeat run

Environment: macOS 26.5.2 arm64 (Darwin 25.5.0), Node 24.13.0, Codex ACP 1.12.0,
`gpt-6-astra` with the existing medium reasoning setting; parallelism 2.
Baseline revision: `da2b5d5`, with content-free instrumentation.

Warm greeting, 30/30 successes, no timeout:

- Runtime completion p95: 4604.34 ms. Repeat-run completion budget: **5756 ms**
  (baseline × 1.25, rounded up).
- First public reply dispatch p95: 4465.07 ms. Repeat budget: **5582 ms**
  (baseline × 1.25, rounded up).
- Quintal queue, context and feedback dispatch: **10 ms p95 each**, comfortably
  above the measured sub-millisecond baseline while catching a new synchronous
  wait in the short-question path.
- Browser feedback: **500 ms p95**; fixture delivery with 200 ms injected runtime
  delay: **750 ms p95**. These are separate transport/UI budgets, not runtime SLAs.

Cold greeting, 30/30 successes: completion p95 7871.90 ms, startup p95 913.40 ms.
These are a separate cohort and are not pooled with warm results.

The 25% margin is a local repeat-run guard, not a statistical significance test
or a production SLA. It does not excuse missing samples or increased failure
rates. Parallel-DM budgets must use its own baseline, not the channel review's
latency or the standalone greeting budget.

The largest observed greeting cost is the ACP runtime boundary, with no tool
calls or approval wait in warm greetings. Provider queue/prefill/generation are
not observable. Do not trade models or increase process limits to meet this
budget. A miss caused by that boundary must be documented as an external/runtime
limitation, with the samples retained.

Concurrent baseline: 30/30 channel reviews and 30/30 DMs, no timeout.
DM completion p95 4675.03 ms and first reply dispatch p95 3051.87 ms.
Fixed repeat budgets: **5844 ms completion**, **3815 ms first reply dispatch**
(baseline × 1.25, rounded up); queue/context/feedback dispatch **10 ms** each.
See `concurrent-dm-budgets.json`.

## Browser delivery change (fixed before implementation)

Real-runtime diagnostic traces exposed viewport shrink from 660 px to 630 px
when the working row appears. A scroll event then reported a 24 px bottom gap,
causing the existing `< 24` pin check to treat the reader as scrolled away.
Several real greetings completed in the runtime but their final answers stayed
off-screen for the entire 30-second diagnostic window.

The fixed before/after browser workload is 60 sequential warm greetings after
one warm-up with a fresh runner, same model/runtime/parallelism and office.
Scroll to the bottom and allow 500 ms for scrolling to settle before each send;
allow 10 seconds for a verified visible final greeting, and retain every missing
or late observation. The browser stays foregrounded. A run must have at least
30 successful observations to compare. The sample is larger because failed
visibility observations cannot be discarded to reach the required count.

Budget: feedback **500 ms p95**, verified first answer and terminal delivery
**6506 ms p95** (the warm runtime budget 5756 ms plus the 750 ms transport/UI
allowance), with **zero missing visible answers** in the repeat. This is a local
budget, not a promise about provider response time. Runtime-only and browser
cohorts remain separate. The proposed change keeps bottom-following current
when the viewport resizes without a message-array change; intentional scrollback
must remain stable.
