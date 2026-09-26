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

## What was not verified, and why

- **The desktop app.** It embeds the same web UI; nothing here touches the
  shell or the sidecar.
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
added. The fix belongs in its own ticket, not smuggled into this one.
