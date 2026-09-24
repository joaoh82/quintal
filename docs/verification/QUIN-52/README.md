# QUIN-52 verification — 2026-09-23

Implementation and checks ran in the `ys/resolve-cards-cancel-crash` worktree on
macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon, from updated main
`3aac853` (later than the ticket's planning baseline `ac66109`). The user
approved the test plan before any check ran.

The office under test ran the production build on port **3052** with a
disposable SQLite database and local storage under `/tmp/quin52-verification`.
**Port 3000 and the user's own office were untouched.** Agent workspaces were
disposable directories under the same temp path.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, server, web, harness, website |
| `pnpm build` | Pass — shared, harness, web, server (exit 0) |
| `pnpm --filter @quintal/shared test` | Pass — **403 tests**, 0 fail (10 new) |
| `pnpm --filter @quintal/server test` | Pass — **113 tests**, 0 fail (18 new) |
| `pnpm --filter @quintal/web test` | Pass — **206 tests**, 0 fail (19 new) |
| `pnpm --filter quintal-acp test` | Pass — **300 tests**, 0 fail (20 new) |
| `pnpm test:release` | Pass — 10 tests |
| `node scripts/check-client-manifest.mjs` | Pass — 24 boundaries, 23 route manifests |
| `git diff --check` | Pass (exit 0) |
| NUL-byte scan of every changed file | Pass — 39 files, 0 NUL bytes |

This repository has no lint script and no formatter.

Two pre-existing tests encoded behaviour this ticket deliberately changes and
were updated rather than worked around: `parallel.test.ts` asserted that a
question names its tool so either of two can be answered by name (they now
carry handles, because two `Bash` questions cannot be told apart by name), and
the `pickWaiter` unit tests pinned the "answer the oldest" rule that was the
bug. `pickWaiter` is deleted; `pickApproval` replaces it with tests of its own.

## Smoke checks and evidence

### HTTP

`node scripts/smoke.mjs http://127.0.0.1:3052` — all 12 checks passed: public
pages, keypair sign-in, redirects, office and settings pages.

### Gateway protocol

`apps/server/scripts/smoke-approvals.mts`, 13 scenarios against the real room
with two agents, three channels, a DM, the owner, a channel member who is not
the owner, and a non-member. [Full report](approval-report.json):

```json
{ "deliveryMs": 24, "pass": true,
  "cardsToOwner": 6, "cardsToMember": 5, "cardsToNonMember": 0,
  "refusals": ["invalid_payload", "not_found", "not_found", "not_found", "missing_scope"],
  "decisions": { "alpha": 1, "beta": 1 },
  "resolutions": [["121be6","allowed"],["c411b4","interrupted"],
                  ["6fa873","interrupted"],["82828e","expired"]] }
```

- Card reached the owner in **24 ms** and the channel's other member; a
  non-member received **nothing** across the whole run (`cardsToNonMember: 0`).
- A member who is not the owner was refused with `missing_scope`, and the
  decision never reached the agent.
- A crafted `allow_always` on a card offering `allow_once`/`deny` was refused
  with `invalid_payload`; an unknown request id and a repeat click on an
  answered one were refused with `not_found`.
- Two agents asked about `Bash` in two channels. Each answer reached only its
  own agent's socket, by request id (`decisions: {alpha: 1, beta: 1}`).
- A card asked in a channel the owner is not in arrived marked `private: true`
  for the owner and un-marked for the member who can read that channel. Asking
  for that channel's history as the owner was still refused.
- A DM card stayed in the DM.
- Agent disconnect closed its open cards as `interrupted`; a pending card was
  replayed to a client's `history_get` while a resolved one was not.
- A card past its deadline was expired by the office and a late answer refused.
- An agent could not put a card in a channel it is not in; a human could not
  send `agent:approval_request` at all.

### Installed runtime, `run` scope disabled

Claude Code via `@agentclientprotocol/claude-agent-acp` 0.81, agent scopes
`chat, status, dm` — no `run`. [Full report](live-probe.json).

| Probe | Card seen | Outcome | Did the tool run? |
| --- | --- | --- | --- |
| Allow once | 2.56 s | `allowed` / `card` | **Yes** — `allow.txt` contained `quintal-probe-allow` |
| Deny | 4.77 s | `denied` / `card` | **No** — `deny.txt` absent |
| Expire | — | `expired` / `timeout` after **302 s** | **No** — `expire.txt` absent |

Each card offered exactly `["allow_once", "deny"]` and carried a 300 s window.
The harness's own audit log records all three against their request ids:

```
Write …/allow.txt  -> once  4ffa4536
Write …/deny.txt   -> deny  0710f4a1
Write …/expire.txt -> deny  de88bf5b
```

A separate live run confirmed the turn is visibly stopped rather than
disguised as work: observed activity states were
`queued → running → waiting → completed`.

### The finding that made the live test possible

The first live run produced **no card at all**: the runtime ran the tool and
answered. Driving the adapter directly showed why —
`@agentclientprotocol/claude-agent-acp` 0.81 opens every session in mode
`auto` ("Claude handles permission decisions") and never sends
`session/request_permission`. An agent **without** the `run` scope was
therefore getting the same silent self-approval as one with it, and every
approval path in the office — the new cards and the text question that
predates them — was dead on the office's primary runtime.

The harness now selects a runtime's asking mode with `session/set_mode` when
the agent has no `run` scope. Evidence, same adapter, same workspace, same
prompt (create a file):

| Mode | `session/request_permission` sent? |
| --- | --- |
| `auto` (the adapter's default) | No — the file was written unasked |
| `default` ("Manual") | **Yes** — `Write`, with the path and a diff |

This is a short verified allowlist (`claude-code` → `default`), not inference
from mode names; other runtimes keep what they open with and the harness logs
that they may never ask. Note that "Manual" asks before *changes* — a file
write asks, a shell `echo` it judges safe does not, which is why the probes
write a file rather than echo.

## What was not verified, and why

- **Browser and desktop by eye.** Not done. Reaching a signed-in office needs
  a session credential, and handling one is outside what I will do; the
  browser tool also blocks cookie access. Substituted with eight
  server-rendered assertions on the card itself
  (`apps/web/src/game/ui/approvalCard.test.ts`): the owner gets Allow once and
  Deny and nobody else gets a button, the buttons disable while an answer is in
  flight, they are replaced by the outcome once resolved, they vanish once the
  deadline passes, `private` is marked, and no control anywhere says "always".
  **A human pass over the live UI is still outstanding** — the layout, the
  amber attention pill on tabs, the private-request strip, and the desktop app.
- **Standing-grant semantics.** Out of scope by design: cards never offer
  `always`. QUIN-53 owns it.
- **Runtimes other than Claude Code.** Codex, opencode and omp are installed
  but their permission modes are not established; the harness leaves them
  alone and says so. Cataloguing them is QUIN-53's scope. Goose is not
  installed (already noted in `COMPAT.md`).
- **Load and performance** beyond the recorded 24 ms card delivery and the
  2.5–4.8 s runtime round trips above.

## Review round 1 (2026-09-24)

Two Hermes reviewers independently found the same real bug, which I had
missed and my own tests could not have caught.

**Pending cards were closed `interrupted` at the top of the agent's `onLeave`,
before `allowReconnection`.** The replay guard then refused to bring them back
on two counts: `resolvedAt` was set, and a reconnect arrives on a new
`sessionId` so `existing.owner !== client.sessionId`. After *any* agent socket
drop the owner saw Interrupted, could not click, and the runtime held its tool
until the five-minute deadline. `#onActivity` has a `!== 'disconnected'`
carve-out for exactly this; I copied the eager close without it. My harness
reconnect test passed because it never touches `OfficeRoom` — the reviewers
said so, and they were right.

Fixed: a replay is matched on the agent's **identity**, and `resumableApproval`
distinguishes a card the office closed because a socket dropped (comes back)
from one the harness settled or one whose deadline passed (stays closed). Five
unit tests in `apps/server/src/rooms/approvals.test.ts`, plus scenario 11 of
the gateway smoke, which now drops the agent, reconnects, replays the same
request id and **answers it** — the step that was dead before.

Three suggestions taken:

- The per-agent and per-room caps refused a request silently. They now refuse
  it with `rate_limited` naming the `requestId`, and the harness denies that
  question at once instead of holding the tool to the deadline.
- `judgeDecision` answered a non-owner with `missing_scope` and the owner's
  name. It now answers `not_found`, the same as a request that does not exist,
  so a guessed id reveals neither whose agent it is nor that it is real.
- The client cleared *every* in-flight click on any refusal. Refusals now
  carry `requestId` (`ErrorPayload`, `AgentErrorPayload`) and only that card is
  un-stuck.

Left as-is, deliberately: the text fallback's `always` still grants runtime
standing while a card records `allow_once`. That is documented and belongs to
QUIN-53; the card does not offer it.

Re-verified after the fixes: 403 / 113 / 206 / 300 tests green, gateway smoke
13 scenarios green (card in 23 ms, `cardsToNonMember: 0`, refusals
`invalid_payload` + four `not_found`, all but the unparseable one naming their
request), and the live runtime again — allow wrote `allow.txt`, deny did not
write `deny.txt`.

## Reproducing

Start the production build on 3052 with an isolated `DATABASE_URL=file:/tmp/…`
and local storage, run the HTTP smoke once to create its identity, then:

```sh
DATABASE_URL=file:/tmp/quin52-verification/office.db \
  pnpm exec tsx apps/server/scripts/smoke-approvals.mts
```

For the live runtime, `apps/server/scripts/seed-live-approval.mts` prints a
mode-0600 seed with a disposable agent key for an agent with no `run` scope;
boot `quintal-acp --key <key> --agent claude-code --url http://127.0.0.1:3052`
against it and run `apps/server/scripts/live-approval-probe.mts` with
`QUIN52_PHASE=allow|deny|expire`. Do not run these against real office data.
