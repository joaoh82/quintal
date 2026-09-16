# QUIN-49 verification — 2026-09-16

Implementation and checks ran in the `live-agent-streaming` worktree on macOS arm64,
from updated main `09ccbc9`. The user approved the verification plan before checks.
The production server used port **3049**, a disposable SQLite DB and storage under
`/tmp/quin49-verification`. Port 3000 and the user's existing office were untouched.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm build` | Pass — shared, harness, web and server |
| Shared test suite | Pass — 388 tests, including migration, sequence ordering, spatial history and payload bounds |
| Server test suite | Pass — 95 tests |
| Web test suite | Pass — 163 tests |
| ACP harness test suite | Pass — 222 tests, including captured runtime fixtures and QUIN-37 communication tests |
| `node scripts/check-client-manifest.mjs` | Pass — 21 boundaries, 23 route manifests |
| `git diff --check` | Pass |

Suite command: `pnpm --filter @quintal/shared --filter @quintal/server --filter quintal-acp --filter @quintal/web test`.
There is no separate lint script. Initial checks found a TypeScript inference error
and two expectations for the old channel avatar status; both were corrected.
A pending permission waiter kept the harness test process alive after shutdown;
shutdown/cancellation now resolves those waiters. An added process-crash regression
also exposed a restart/stop race: a worker finishing initialization after shutdown
could leave a child process alive. The worker now owns its process before awaiting
initialization and closes a bridge opened during shutdown. The focused regression
exits cleanly; the final harness rerun passed.

## Smoke checks and evidence

- **HTTP:** `node scripts/smoke.mjs http://127.0.0.1:3049` passed all 12 checks:
  public/login/invite responses, signed keypair login, redirects, office and settings pages.
- **Migration/storage:** the production server applied migration 0029 to the isolated
  database. The shared DB test applied all migrations and exercised durable upserts.
  [Protocol evidence](protocol-report.json) records completed, cancelled and disconnected
  rows, with one row per agent/turn despite repeated updates.
- **Gateway:** `apps/server/scripts/smoke-activity.mts` passed with two agents and two
  simultaneous channels, plus a DM. It checks queue feedback, tool rows before the
  final reply, secret redaction, duplicate/out-of-order updates, sender forgery,
  cross-channel rerouting, restricted history, disconnect/reconnect, cancellation,
  late terminal updates and active-turn recovery beyond the latest history page.
  Zero activity leaked to the nonmember and zero agent wakeups occurred.
  Restricted history returned `{"code":"unauthorised","message":"Not a channel you are in."}`.
- **Browser:** inspected compact and expanded transcripts in Brave. Three command
  rows show success/success/failure, durations, narration before tools, and an
  expandable redacted detail. Channel switch/return and reload retained one copy of
  each step. [Screenshot](browser-steps.png).
- **Streaming/latency:** 20 updates at 250 ms intervals, timestamped immediately before
  gateway send, measured by a browser MutationObserver when public text reached the DOM.
  All 20 arrived: **102–111 ms**, median **105 ms**, against a 500 ms target.
  This includes server coalescing and transport; it excludes model generation and the
  harness's separate 100 ms coalescing window. [Samples](dom-latency.json).
- **Scrolling:** at the bottom, scrollTop followed growth to 1697.5 px in a 1857 px
  transcript with a 160 px viewport. After scrolling to the top, another 20-update
  stream grew the transcript to 3558 px while scrollTop stayed **0**.
  [Evidence](scroll.json). Payload/item caps and coalescing are also tested in the harness.

## Installed runtime evidence

Ran `ls <temporary workspace>`, `uname -a`, and `false` as separate tools against
installed ACP runtimes, capturing actual public payloads. The probe fed those updates
through `PublicTurn`; tool snapshots appeared before the final reply. Commands used
an isolated workspace containing `fixture.txt`. Sanitized replay fixtures are in
[`packages/acp-harness/test/fixtures/activity`](../../../packages/acp-harness/test/fixtures/activity).
Runtime probes and gateway/browser smoke were separate stages; this was not a native
harness-launch end-to-end test.

| Runtime / adapter | Version | Result |
| --- | --- | --- |
| Claude ACP | 0.78.0 | Pass; raw string results, explicit failed status |
| Codex ACP | 1.12.0 | Pass; `rawOutput.exit_code` |
| OpenCode | 1.4.3 | Pass after adapting `rawOutput.metadata.exit`; `false` reports completed with exit 1 |
| Oh My Pi | 18.1.15 | Pass; `rawOutput.details.exitCode`, concurrent tool ordering |
| Gemini CLI | 0.25.2 (initialize omits version) | Blocked: `RequestError: Authentication required` |
| Goose | Not installed | Not run |

The captured OpenCode case now has a regression test: a nonzero exit is failed even
without an error string. Missing result evidence remains unknown. No Hermes event
names were used.

## Limitations and follow-up

- **Desktop visual acceptance remains unverified.** An isolated copy of the prebuilt
  Tauri host, pointed at port 3049, opened a blank webview with no page accessibility
  content. [Screenshot](desktop-blank.png). No native source changed; Rust/native
  suites and release signing were not run. Restore the local desktop test host and
  repeat conversation checks before treating the task as fully accepted.
- Gemini needs an authenticated runtime before its live scenario can be verified.
- No remote production DB, deployment, external service mutation, or background-job
  check was needed. This change adds no background job.
- Bounds are tested per snapshot and transcript retention is capped at 500 rows;
  sustained multi-hour/high-concurrency load and a maximum-size 500-turn browser
  rendering benchmark were not run. Recommend tracking those latency/load checks in
  **QUIN-50**. The local sample is evidence for this environment, not a production SLA.
- **QUIN-52** should use the turn's `requestId` correlation root for approval cards.
  Approval UI and Markdown rendering remain their own tasks.

Full local command logs remain under `/tmp/quin49-verification` (`tests-final.log`,
`typecheck-final.log`, `build-final.log`, `http-smoke.log`, `protocol-final.log`, and
runtime probe logs, and `harness-crash-final.log`). These may contain machine-specific diagnostics and are not
committed. Credentials and private thought chunks are not included in this report.

## Reproducing the protocol/stream smoke

Start the production build on 3049 with an isolated `DATABASE_URL=file:/tmp/...` and
local storage, then run the HTTP smoke once to create its test identity. Create
`/tmp/quin49-verification`, then run:

```sh
DATABASE_URL=file:/tmp/quin49-verification/office.db pnpm exec tsx apps/server/scripts/smoke-activity.mts
pnpm exec tsx apps/server/scripts/smoke-activity-stream.mts
```

The protocol smoke writes a mode-0600 seed file with disposable agent keys. The stream
smoke reuses that seed. Open the newly created Activity channel to inspect streaming.
Do not use these scripts against real office data.
