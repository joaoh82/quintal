# QUIN-70 verification — 2026-09-26

Implementation and checks ran in the `ys/agent-card-runtime-model` worktree on
macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon, from updated main
`825a5e6` (`release: v0.5.0`). The user approved the test plan before any check
ran, and asked for the guide's screenshot to be replaced in the same PR.

The office under test ran the production build on port **3170** with a
disposable SQLite database and local object storage under the session's
scratchpad. **Port 3000 and the user's own office were untouched.** The three
agents, their keys and the signed-in identity exist only in that throwaway
database.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, server, web, harness, website, root |
| `pnpm build` | Pass — shared, harness, web, server |
| `pnpm --filter @quintal/shared test` | Pass — **407 tests**, 0 fail (4 new) |
| `pnpm --filter @quintal/web test` | Pass — **216 tests**, 0 fail (5 new) |
| `pnpm --filter @quintal/server test` | Pass — 113 tests, 0 fail |
| `pnpm --filter quintal-acp test` | Pass — 300 tests, 0 fail |
| `pnpm test:release` | Pass — 12 tests |
| `node scripts/check-client-manifest.mjs` | Pass — 24 boundaries, 23 route manifests |
| `pnpm db:generate` | "No schema changes, nothing to migrate" — **no migration needed** |
| `git diff --check` | Pass (exit 0) |
| NUL-byte scan of every changed file | Pass — 0 NUL bytes |

No existing test had to change: the two roster fixtures gained the two new
`RosterEntry` fields and nothing else moved.

`runtime_id` and `model_id` have been columns on `agents` since fleet
definitions landed; this ticket only reads them, which is why `db:generate`
finds nothing to write.

## Smoke checks and evidence

### HTTP

`node scripts/smoke.mjs http://127.0.0.1:3170` — all 12 checks passed: public
pages, keypair sign-in, redirects, office and settings pages.

### The three cases, in a real office, through the browser

One signed-in human (`Dpr010`) and three agents, each joined over the real
gateway with its own key. The office is the production build; the cards below
were opened by clicking the agent's name in the roster, exactly as a person
would. Row text was also read back out of the DOM ([cards.json](cards.json)).

| Agent | Row in `agents` | Card says | |
| --- | --- | --- | --- |
| Arthur | `runtime_id='codex'`, `model_id='gpt-6-astra'` | `runtime Codex` · `model gpt-6-astra` | [card-arthur.png](card-arthur.png) |
| Marvin | `runtime_id='claude-code'`, `model_id=NULL` | `runtime Claude Code` · `model default` | [card-marvin.png](card-marvin.png) |
| Scout | not office-defined (both NULL) | **neither row** — `scopes` straight to `acted` | [card-scout.png](card-scout.png) |

The three facts the ticket turns on, each seen in the live UI:

- A runtime id becomes the catalogue's label: the row reads `Codex`, not
  `codex`.
- An unchosen model reads `default` rather than being blank or absent — it is a
  state its owner can set and unset, so the card says it.
- An agent the office does not define shows nothing at all. Scout's card goes
  from `scopes` to `acted` with no gap and no "unknown".

### The replaced guide screenshot

`screenshots/agent-profile-card.png` was re-shot in that same office, with the
same cast the rest of the guide uses (owner `Dpr010`, agents `Arthur` and
`Marvin`) and the same runtime/model pairing as `settings-agents.png`, so the
two images agree. Arthur's card is the one open, because it shows a named model
rather than `default`.

One honest regression: the new capture is 1455×816 (1×), where the file it
replaces was 2548×1560 (2× retina). It was taken through the browser
automation tool, which returns the viewport at CSS resolution. It is legible at
the size the guide renders it, and within the "roughly 1600px wide" rule in
`screenshots/README.md`, but it is not as sharp as the old asset. Worth
re-taking by hand on a retina display the next time somebody is in front of one.

## Review round — 2026-09-26

Three points came back on [PR #121](https://github.com/joaoh82/quintal/pull/121)
(two Hermes reviews, both approving, and a human P2 inline). All three are
fixed in the follow-up commit; the fourth suggestion was declined on purpose.

### P2: a long model id left the card

`setAgentLaunch` truncates a model id to 128 characters and does not validate
it — the value is whatever a runtime calls its own models. The `<dd>` was a
flex item with no `min-w-0` and no break rule, so a long unbroken id ran out
past the edge of the card.

Measured in the live office, same card, 128 characters with no break
opportunity (`getBoundingClientRect().right`, card right edge at **1703**,
viewport 1728):

| | value's right edge | lines |
| --- | --- | --- |
| Without `min-w-0 break-all` | **2388** — 685px past the card, off the viewport | 1 |
| With them | **1690** — inside the card | 6 |

Then with a real id rather than a synthetic one: Arthur's model was set through
`setAgentLaunch` to a 136-character provider-qualified id, stored truncated to
128, and the agent reconnected. The card wraps it over six lines and keeps its
width; neither the roster nor the document scrolls sideways
([card-long-model.png](card-long-model.png)).

The `runtime` row above it needs none of this: that id is refused on write
unless it is in the catalogue (`Unknown runtime "…"`, `settings/agents/actions.ts:152`),
and every label in the catalogue is one or two words.

### The `OfficePlayer` comment said something untrue

Both reviews caught the same line: the schema comment claimed an empty
`runtimeId` *or* `modelId` meant the office does not define the agent. Only
`runtimeId` means that. An empty `modelId` beside a runtime is that runtime's
default, and the card prints `default` — which is the whole point of the
distinction. The comment now says so, and no longer fights `runtimeLines`.

### Field order on the wire

`defineTypes` had the two new fields beside `scopes`, where they read best,
which shifted the index of every field after them. The browser decodes with
its *own* copy of `OfficeState` — `net/connection.ts:83` passes the class to
`joinOrCreate` rather than taking the server's reflection — and `net/recovery.ts`
rejoins a dropped socket without reloading the page, so a tab that was open
across an office upgrade would decode with the old layout. Both fields are now
appended, with the reason written down.

(The harness is unaffected either way: `packages/acp-harness/src/gateway/client.ts:110`
joins without a schema class and never reads room state — it works off
`agent:*` messages.)

### Declined: refreshing an open card on a settings save

Suggested, and deliberately not done. Runtime and model land on the next
connect, exactly as `instructions` do; pushing a mid-session update means a new
fact on the wire and a card that disagrees with the process actually running.
Called out in the ticket's "not in this ticket" and unchanged here.

## What was not verified, and why

- **The desktop app.** It loads the office page from the server over HTTP
  (`docs/DESKTOP.md`, "The app needs a server to connect to"), so it runs the
  very code checked above; nothing here touches the shell or the sidecar.
- **Real runtimes actually spawning.** The card shows what the office recorded,
  not what a process is doing, so the agent sockets were the reference demo
  agent rather than Claude Code or Codex. Booting real CLIs would have
  exercised nothing on this path.
- **Per-viewer differences.** The two rows are not owner-gated (neither are
  `scopes` or `status`), so there is no second view to check.
- **Model labels resolved through `agent_hosts.runtimes`.** Out of scope by
  design — see the ticket.

## One finding, unrelated to this ticket

`scripts/demo-agent.ts` — the reference agent `docs/GATEWAY.md` points at as
the worked example — cannot join any office. It joins with
`{ agentKey, mapId }` and never sends `workspaceId`, so the room refuses it
with `No office was named in this join.` (code 4215). GATEWAY.md itself
documents the correct sequence (`POST /api/agent/office` first, then join with
the `workspaceId` it returns); the script was not updated when rooms became
one-per-office.

This verification ran against a local copy of the script with those four lines
added. The fix belongs in its own ticket, not smuggled into this one — filed as
**QUIN issue #1**, "The reference agent can't join an office — demo-agent never
sends workspaceId".
