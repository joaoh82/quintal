# QUIN-51 verification

## Scope and environment

Implementation and checks ran in the `workspace-discovery-query` worktree, based
on main `51f244b` (later than the ticket's planning baseline `ac66109`). The
test plan was approved by the user before execution.

macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon. The live runtime was
Claude Code through `npx -y @agentclientprotocol/claude-agent-acp`, on the
runtime's default model. All fixtures — workspaces, repositories directories and
checkouts — were disposable directories under the system temp dir and were
removed afterwards. **No office server was started and port 3000 was untouched**;
see "What was not verified" for why, and for what that leaves unproven.

The planted credential in the fixtures (`ghp_LIVE…`, `ghp_SMOKE…`) is a made-up
string, not a real token.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, server, web, harness |
| `pnpm build` | Pass — shared, harness, web, server (exit 0) |
| `pnpm --filter quintal-acp test` | Pass — **258 tests**, 0 fail (23 new) |
| `pnpm --filter @quintal/shared … test` | Pass — shared 393, server 95, web 168, 0 fail |
| `git diff --check` | Pass (exit 0) |
| NUL-byte scan of every changed file | Pass — 0 NUL bytes; all files UTF-8 text |

No lint script is provided by this repository, and it has no formatter.

## Smoke checks

### The real MCP tool server

The built `quintal-tools` stdio server, spoken to over real MCP against a real
loopback bridge — no test fixture standing in for either.
[Evidence](mcp-tool-calls.json).

- `tools/list` advertises `workspace_info` alongside the nine existing tools.
- Five `tools/call` invocations, **one call each**, 1.1–23.4 ms (the first
  includes process warm-up). Harness-side cost is a single directory read.
- Payloads, in order: a nest whose `REPOS/` links to a repositories directory
  (three entries, the two checkouts first and the non-git one marked
  `git: false` after them); the same session after a
  repository was cloned **between calls**, which the second answer includes
  (nothing is cached); an empty repositories directory (`"nothing cloned here
  yet"`, not "missing"); a `REPOS/` link whose target is gone (`"this directory
  is not there"`); and a custom cwd rooted in one checkout, which reports
  `working_directory_repo: "github.com/acme/api"` from an `ssh://` remote and
  `repositories.path: null`.
- **Credential redaction:** the `quintal` fixture's origin is
  `https://x-access-token:ghp_…@github.com/joaoh82/quintal.git`. It comes back as
  `github.com/joaoh82/quintal`. No payload contains `ghp_` or `x-access-token`.

### A live agent, cold and warm

A real runtime, the real harness and the real tool server, asked the ticket's
question. [Strict scenario](live-claude-code-strict.json) — the three questions
alone — and [with an explicit GitHub question](live-claude-code.json).

| Turn | Dedicated discovery calls | Other tool steps | Elapsed |
| --- | --- | --- | --- |
| Cold (strict) | **1** (`workspace_info`) | none | 25.0 s |
| Warm, asked about GitHub access | 0 | 3 deliberate `gh` / `git ls-remote` commands | 41.2 s |
| Cold, question included GitHub | **1** (`workspace_info`) | 1 deliberate `gh auth status` / `gh repo view` command | 32.9 s |
| Warm, asked repos + `move` again | 0 | none — answered from context | 4.1 s |

`ToolSearch` also appears in the cold turns: that is the Claude Code runtime
loading its own deferred tool schemas, not a probe of the machine. **No `pwd`,
`ls`, `find`, `cd` or `git remote` was run to answer the workspace question in
any turn.**

The cold answer named the working directory, the three checkouts with their
redacted remotes, the granted scopes, the missing `move` scope and the unscoped
tools — and, unprompted, drew the distinction the ticket asks for:

> I haven't checked whether I can still read or push to those GitHub repos.
> Having a copy on this machine doesn't prove that.

Asked directly about GitHub access, it verified deliberately with the
credentials the runtime already had (`gh auth status`, `gh repo view --json
viewerPermission`, `git ls-remote`) and reported the result without overclaiming
— "ADMIN permission should allow it, but I haven't tried a push", and "the push
rights come from your personal login on this machine, not from an account of my
own". Neither live transcript contains the planted token.

One incidental finding: in the second run the model read the fixture's
`.git/config` itself with Bash and noticed the token written in it, reporting
that it was there without repeating it. Worth stating plainly — `workspace_info`
guarantees only that *it* never hands a credential to the model; a runtime with
shell access can still read any file the agent can read.

### Nest migration

[Evidence](nest-migration.json). A v2 `AGENTS.md` with the owner's own section
below the end marker, then a fleet start:

- `.nest-version` moves 2 → 3, and the new `workspace_info` lines appear in both
  the `REPOS/` row and the Reading section (absent before, present after).
- The owner's section below the end marker survives verbatim.
- A second `ensureNest` changes nothing (idempotent), with no warnings.

### Listing order, against a real repositories directory

Found while smoke-testing the branch on the author's own machine, and fixed
before merge. `~/projects` there holds 76 directories: 38 checkouts and 38 plain
folders. An alphabetical cut at 60 dropped **nine real checkouts** — `rustunnel`,
`this-week-in-rust`, `rust_sqlite` among them — while listing scratch folders
ahead of them.

Checkouts are now listed first and plain directories take what room is left, each
group alphabetical, with the cap unchanged. The same machine now lists all 38
checkouts plus 22 folders, `more: 16`. When the cut does reach checkouts the
answer says so, rather than letting the agent read a truncated list as complete.

## What was not verified

- **No live office server.** `workspace_info` is answered entirely by the
  harness and never crosses the gateway, so the office contributes only the
  `ready` payload (name, owner, scopes), which the live run supplied directly.
  What this leaves unproven: the tool has not been exercised against a real
  `agent:ready` from a running office, nor through the desktop app's sidecar.
- **Remote permission checks are not part of the feature.** The tool never
  contacts a remote by design; the only remote verification in this report is
  the model's own deliberate `gh`/`git` check.
- **One runtime.** Claude Code only. Codex, Gemini and Amp are installed on this
  machine and were not run.
- **Desktop packaging and native builds** were untouched and not rebuilt.
- Timings are from a developer laptop with other work running; they bound the
  tool's cost, they are not a benchmark.
