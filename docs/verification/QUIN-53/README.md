# QUIN-53 verification — 2026-09-26

Implementation and checks ran in the `ys/test-withdrawing-run-permission`
worktree on macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon, from
`825a5e6` (`release: v0.5.0`), which contains `origin/main` — later than the
ticket's planning baseline `ac66109`. The user approved the test plan before
any check in the "Smoke checks" section ran.

The office under test ran the production build on port **3057** with a
disposable SQLite database and local storage under `/tmp/quin53-verification`.
**Port 3000 (the user's own dev server) and port 3052 (a server belonging to
the `/Users/joaoh82/projects/quintal` checkout) were left alone**; both were
still running, untouched, afterwards. Agent workspaces were disposable
directories under the same temp path.

## What the ticket was about, and what was actually found

The ticket said Quintal labels a standing grant it cannot explain. Probing the
installed runtimes found something worse than a label problem.

`#onPermissionRequest` answered the `run` scope's automatic approvals with
`select(options, 'always')`, which took **the first option carrying the ACP
kind `allow_always`**. On a Claude Code plan-exit request the options are:

```
exit-plan-default     allow_once    "Yes, manually approve edits"
exit-plan-clear-auto  allow_always  "Yes, clear context (4% used) and use auto mode"
exit-plan-auto        allow_always  "Yes, and use auto mode"
exit-plan-bypass      allow_always  "Yes, and bypass permissions"
reject                reject_once   "No, keep planning"
```

The first `allow_always` is `exit-plan-clear-auto`. So a question nobody read
could put the session into auto mode — where it stops asking entirely — *and*
discard the conversation. The `kind` is not a promise, and reading it was the
whole policy.

Two more findings, both recorded in
[docs/RUNTIME-PERMISSIONS.md](../../RUNTIME-PERMISSIONS.md):

- **Codex 1.13.1 never asks over ACP, in any of its three modes** — and in
  `read-only`, the mode it describes as *"Always ask to edit external files"*,
  it created a file **outside its working directory** without asking. No
  approval card can reach that runtime.
- **opencode 1.4.3 never asks either**, in `build` or `plan`, for a write, a
  shell command, or a write outside the workspace.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, harness, web, server, website (exit 0) |
| `pnpm build` | Pass — shared, harness, web, server (exit 0) |
| `pnpm --filter @quintal/shared test` | Pass — **413 tests**, 0 fail (10 new) |
| `pnpm --filter @quintal/server test` | Pass — **113 tests**, 0 fail |
| `pnpm --filter @quintal/web test` | Pass — **216 tests**, 0 fail (5 new) |
| `pnpm --filter quintal-acp test` | Pass — **314 tests**, 0 fail (6 new) |
| `pnpm test:release` | Pass — 12 tests |
| `node scripts/check-client-manifest.mjs` | Pass — 24 boundaries, 23 route manifests |
| `git diff --check` | Pass (exit 0) |
| NUL-byte scan of every changed file | Pass — 25 files, 0 NUL bytes, no binaries |

This repository has no lint script and no formatter.

One pre-existing test encoded behaviour this ticket deliberately changes and
was updated rather than worked around: the `run`-scope integration test
asserted the audit line read `allowed by the run scope`, which is now a
structured row naming the runtime option taken. One test was renamed —
`takes "always" as a standing approval` became `still accepts the documented
"always" word as an answer`, because it no longer buys standing.

## Smoke checks and evidence

Full output: [live-probe.json](live-probe.json). Runtime option payloads:
[runtime-options.json](runtime-options.json). Grant-lifetime measurements:
[grant-lifetime.json](grant-lifetime.json).

### HTTP

`node scripts/smoke.mjs http://127.0.0.1:3057` — all 13 checks passed.

### Gateway protocol

`apps/server/scripts/smoke-approvals.mts`, 13 scenarios against the real room:
`pass: true`, card delivered to the owner in **22 ms**,
`cardsToOwner: 7`, `cardsToMember: 5`, **`cardsToNonMember: 0`**, refusals
`invalid_payload` + four `not_found`.

The one that matters here: **a crafted `approval_decide` naming
`allow_always` on a card that offered `allow_once`/`deny` was refused with
`invalid_payload`** — server-side, not by a hidden button.

### The `run` scope takes a per-call allow, live

**omp** (`oh-my-pi` 18.2.6), agent scopes `chat, status, dm, run`. omp asks
before shell commands and offers all four kinds:
`allow_once` "Allow once" · `allow_always` **"Always allow"** ·
`reject_once` "Reject" · `reject_always` "Always reject".

Measured for the catalogue: "Always allow" covers the **whole shell category
for the session** — after taking it, a *different* command was not asked
about again. So this runtime is where the old behaviour is directly
observable.

| Step | Asked again? | Option taken |
| --- | --- | --- |
| First action (`touch one.txt`) | — | `allow_once` |
| A different action, same session (`touch two.txt`) | **Yes** | `allow_once` |
| A third, same session (`touch three.txt`) | **Yes** | `allow_once` |
| After a runtime restart, new session (`touch after-restart.txt`) | **Yes** | `allow_once` |

`askedAboutEveryAction: true`, `everyAnswerPerCall: true`,
`optionsTaken: ["allow_once:allow_once"]`, `actors: ["run_scope"]`. The old
code would have taken `allow_always` on the first request and the three later
actions would not have been asked about at all.

The audit row, from the harness's own log:

```json
{ "kind": "permission", "requestId": "14b85826-…",
  "tool": "touch one.txt && ls -l one.txt",
  "summary": "touch one.txt && ls -l one.txt",
  "actor": "run_scope", "decision": "once", "runtime": "omp",
  "runtimeOption": "allow_once", "runtimeOptionKind": "allow_once",
  "breadth": "this_call", "lifetime": "this_call", "persistsAt": null }
```

That covers the ticket's acceptance sequence — once, a different action in the
same category, a new conversation, and a runtime restart, in an isolated
workspace — and every result matches the label.

### The card takes the narrowest allow, live

**Claude Code** via `@agentclientprotocol/claude-agent-acp` 0.81.2, agent
scopes `chat, status, dm` — no `run`. The harness set the session to
`default` ("Manual"). A file-edit request there offers **both** `allow-once`
(per call) and `allow-with-updates` ("allow all edits in `<dir>`/ during this
session").

| Probe | Card seen | Card options | Option taken | Did the tool run? |
| --- | --- | --- | --- | --- |
| Allow | 4.98 s | `allow_once` "Allow once" · `deny` "Deny" | **`allow-once`** | **Yes** — `allow.txt` held `quintal-probe-allow` |
| Deny | — | same | **`reject`** (`reject_once`) | **No** — `deny.txt` absent |

The card never offered the directory-wide option, and the answer took the
per-call one:

```json
{ "actor": "Approval Owner", "decision": "once", "runtime": "claude-code",
  "runtimeOption": "allow-once", "runtimeOptionKind": "allow_once",
  "breadth": "this_call", "lifetime": "this_call" }
```

### Withdrawing run permission

The branch's namesake, and the check the ticket asks for by name. Same agent,
same runtime, same workspace, `run` taken away in between.

`apps/server/scripts/live-withdraw-run.mts` — data layer:

- `scopesBefore: [chat, status, dm, run]` → `scopesAfter: [chat, status, dm]`,
  re-read from the row rather than trusted from the call.
- Audited as `agent.scopes_changed` with `removed: ["run"]`, `added: []`, and
  the user id who did it.
- The notice's wording is asserted, not assumed: it must say what it fails to
  revoke and must not claim a revocation anywhere.

> Quintal stops answering for it from its next session. Allow rules kept by
> the runtime itself are not revoked by this — they live in the runtime's own
> settings and are removed there.

- `appCreatedPersistentGrants: 0`. Quintal writes no grants, so there is no
  list to show and no revocation path to offer; the externally managed ones
  are named with the file that holds them.

Then the behavioural half — the same omp agent, restarted:

| | Before withdrawal | After withdrawal |
| --- | --- | --- |
| Cards seen | **0** | **1** |
| Who decided | `run_scope` | `Approval Owner` |
| Card options | — | `allow_once` "Allow once" · `deny` "Deny" |
| Option taken | `allow_once` | **`reject_once`** |

The harness also logged, on reconnect: *"omp decides tool permissions itself
(mode "default"); this agent has no "run" scope, but its runtime may never
ask"* — honest about what it has not established, even though omp did in fact
ask.

Two details worth naming. The card offered **"Allow once"** while omp had also
offered `allow_always` — the narrowest-explainable rule picked the per-call
option and labelled it for what it does. And Deny took **`reject_once`**, not
the `reject_always` omp also offered: a standing refusal would deny requests
the owner never saw.

**No runtime grant was created by any of this.** `~/.claude/settings.json`,
`~/.claude/settings.local.json`, `~/.codex/config.toml` and
`~/.gemini/settings.json` were byte-identical before and after the whole run.

## What was not verified, and why

- **Browser and desktop by eye.** Not done — reaching a signed-in office needs
  a session credential, and the browser tool blocks cookie access. Substituted
  with server-rendered assertions on the card
  (`apps/web/src/game/ui/approvalCard.test.ts`): the button prints the label
  the harness sent rather than a hard-coded "Allow once", and a request whose
  allow could not be explained renders with **no allow button at all**. The
  new scopes editor and its withdrawal notice have the action's own tests and
  the live data-layer check above, but **a human pass over the live UI is
  outstanding**.
- **The run-scope refusal path, live.** Every installed runtime that asks
  offers a per-call allow, so no real runtime reaches
  `refused: unexplained_allow` / `not_per_call`. Covered by unit tests against
  the recorded plan-exit payload and by integration tests against a fake
  runtime offering only `allow_always`.
- **Gemini CLI and Goose.** Gemini has no API key on this machine and Goose is
  not installed; both stay `unknown` in the catalogue, which means their
  options would not be offered on a card.
- **Load and performance** beyond the 22 ms card delivery and the 2–5 s
  runtime round trips recorded above.

## Reproducing

Start the production build on 3057 with an isolated database and local storage
(`NODE_ENV=production PORT=3057 STORAGE_ALLOW_LOCAL=1 BETTER_AUTH_SECRET=…
DATABASE_URL=file:/tmp/quin53-verification/office.db`), run the HTTP smoke once
to create an identity, then:

```sh
export DATABASE_URL=file:/tmp/quin53-verification/office.db

# gateway protocol, including the crafted allow_always
QUIN52_URL=http://127.0.0.1:3057 pnpm exec tsx apps/server/scripts/smoke-approvals.mts

# an agent WITH run, on a runtime that asks
QUIN_SCOPES=chat,status,dm,run pnpm exec tsx apps/server/scripts/seed-live-approval.mts > seed.json
# boot: quintal-acp --key <agentKey> --agent omp --url http://127.0.0.1:3057 --log-dir <dir>
QUIN53_SEED=seed.json QUIN53_LOGS=<dir> QUIN53_URL=http://127.0.0.1:3057 \
  QUIN53_ACTIONS='["one.txt","two.txt"]' \
  pnpm exec tsx apps/server/scripts/live-run-scope-probe.mts

# withdraw it, then restart the harness and run the probe again
QUIN53_SEED=seed.json pnpm exec tsx apps/server/scripts/live-withdraw-run.mts
```

For the card path, seed without `QUIN_SCOPES`, boot on `claude-code`, and run
`apps/server/scripts/live-approval-probe.mts` with `QUIN52_PHASE=allow|deny`.

To re-establish the catalogue itself, see *Re-establishing it* in
[docs/RUNTIME-PERMISSIONS.md](../../RUNTIME-PERMISSIONS.md). Do not run any of
this against real office data.
