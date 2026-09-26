# Runtime permissions: what each option actually grants

An ACP runtime asks "may I run this?" by sending `session/request_permission`
with a list of options. Each option carries an id, a name it would show a
human, and an ACP `kind` — `allow_once`, `allow_always`, `reject_once`,
`reject_always`.

Quintal used to read the kind and nothing else: an automatic approval took
whichever option said `allow_always`, and the question in chat called that
"for the rest of this session". Both halves were guesses.

`allow_always` is a kind, not a promise. Measured against the runtimes people
actually have installed, the same kind means:

- "allow all edits in this directory during this session" (Claude Code, on a
  file edit),
- "allow anything this tool does, this session" (Oh My Pi, on a shell command),
- and, on a Claude Code plan-exit request, **"use auto mode"**, **"clear
  context and use auto mode"** and **"bypass permissions"** — three options of
  that one kind, none of them a grant for the tool being asked about.

So the office does not read kinds. It reads a catalogue of facts established
against real runtimes — `packages/shared/src/runtime-permissions.ts` — and
`unknown` is a first-class answer there. An option nobody has measured is
never offered to a person, never taken automatically, and never described.

## The rules that follow from it

1. **A label may never promise less authority, or a shorter life, than the
   option it takes.** The button's words and the option sent back to the
   runtime come from one function (`pickAllow`), so they cannot drift apart.
2. **The narrowest explainable allow wins** — not the first of a kind.
3. **Unknown is not offered.** A runtime whose only allow option is an
   unmeasured "always" gets a card with Deny and no allow button at all.
3a. **Neither is anything that buys less asking later.** Breadth and lifetime
   do not capture that on their own, and the gap had teeth: Claude Code's four
   plan-exit options are *all* `session_policy` + `session`, so they ranked
   equal and the choice fell to whatever order the runtime happened to send —
   "Yes, manually approve edits" and "Yes, and bypass permissions" were
   interchangeable. So each option states `loosensFuturePermission`
   separately, it is ranked *before* breadth, and a loosening option is never
   offered as an allow at all. Clicking one button on one request answers that
   request; "and stop asking me" is not a rider the owner agreed to.
3b. **The runtime is resolved from `runtimeId`, not `harness`.** An
   office-defined agent is built by `host.ts` with `harness: 'custom'` and its
   real runtime in `runtimeId`, so keying the catalogue on `harness` bypassed
   every measured fact on the path almost every agent takes — including the
   plan-exit safeguard. One resolver, `runtimeIdOf`, and the asking-mode
   allowlist goes through it too.
4. **The `run` scope may only take a genuine per-call allow.** An automatic
   approval nobody sees must leave nothing behind. Where no per-call allow is
   offered, the runtime is answered `cancelled` and the audit row says which
   of the two reasons applied. This is the documented policy, not a fallback.
5. **A denial denies this call only.** A runtime that offers "Always reject"
   is offering a standing refusal; taking it would refuse requests the owner
   was never shown, which is the same failure pointed the other way. With no
   `reject_once` the runtime gets `cancelled`, which every ACP agent must
   accept.
6. **An affirmative answer that cannot be honoured is a denial, not an
   approval.** Where nothing offered can be taken, `yes` and `always` settle
   the card `denied` — because `cancelled` is what the runtime is told, and a
   resolution reading `allowed` would describe an approval that happened
   nowhere.
7. **Quintal creates no persistent grants.** Nothing in the app writes an
   allow rule into a runtime's settings, so there is no list of app-created
   grants to show and no revocation path to offer. Grants that exist in a
   runtime are that runtime's, and are removed with that runtime's own tools —
   see *Grants Quintal cannot revoke* below.

`allow_once` and `reject_once` do have a default for a runtime nobody has
catalogued, and it is read from the protocol rather than guessed from the
name: ACP defines them as permitting or refusing *this* operation. That is
what keeps a newly released CLI usable. `allow_always` gets no default,
because there is no honest one to give.

## What was found

Probed on macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon, on
2026-09-24, with `packages/acp-harness/scripts/probe-permissions.mts` (which
answers every request `cancelled`, so nothing runs and no grant is created)
and `probe-grant-lifetime.mts` (which takes one standing grant in a disposable
workspace and then measures how far it reaches). Full output:
[docs/verification/QUIN-53](verification/QUIN-53/).

### Claude Code — `@agentclientprotocol/claude-agent-acp` 0.81.2

Asks only in the `default` mode, which it calls **Manual — "Always ask before
making changes"**. In `auto` (its default), `acceptEdits` and
`bypassPermissions` it never sends a request at all. The harness moves a
session without the `run` scope into `default` for exactly this reason.

Manual asks before *changes*: a file edit asks, and a shell command it judges
safe does not.

| Request | Options offered |
| --- | --- |
| File edit | `allow-once` "Yes" · `allow-with-updates` "Yes, allow all edits in `<dir>`/ during this session" · `reject` "No" |
| Shell command | `allow-once` "Yes" · `reject` "No" — **no standing option at all** |
| Plan exit (`toolCall.kind: switch_mode`) | `exit-plan-default` "Yes, manually approve edits" · `exit-plan-clear-auto` "Yes, clear context and use auto mode" · `exit-plan-auto` "Yes, and use auto mode" · `exit-plan-bypass` "Yes, and bypass permissions" · `reject` |

Of the plan-exit options only `exit-plan-default` is offerable: it leaves plan
mode for Manual, so the session goes on asking. Its button says **"Allow, and
keep asking"** rather than "Allow once" — it is a policy change, not a single
allow. The other three stop the session asking and one of them discards the
conversation, so no card offers them and the `run` scope refuses the request
outright.

`allow-with-updates` names its own breadth and lifetime, and the measurement
agrees with the name: after taking it, the same edit and a *different* edit in
that session were not asked about again; a new session asked again, and so did
a restarted process; no runtime settings file changed.

The plan-exit row is the one that matters most. Its first `allow_always` is
`exit-plan-clear-auto` — so the old "take the first `allow_always`" rule would
have answered a plan approval by putting the session into auto mode *and*
discarding the conversation, from a question nobody ever read.

### Oh My Pi (`omp`) — `oh-my-pi` 18.2.6

Asks before shell commands in its `default` mode; it did not ask before
writing a file in the working directory. In `plan` mode it asked before a
shell command that reached outside the workspace.

Options: `allow_once` "Allow once" · `allow_always` **"Always allow"** ·
`reject_once` "Reject" · `reject_always` "Always reject".

"Always allow" says nothing about breadth or lifetime, so it was measured.
After taking it: the same command was not asked about again, **a different
shell command in that session was not asked about either**, a new session
asked again, and a restart asked again. Nothing under `~/.omp` changed but
session transcripts, logs and model caches. So: the whole shell category, for
this session, not written down.

### Codex — `@agentclientprotocol/codex-acp` 1.13.1

**Never sent `session/request_permission`** — not for a file write, not for a
shell command, and not for a write outside the working directory, in any of
its three modes (`agent`, `read-only`, `agent-full-access`).

In `read-only`, the mode it describes as *"Always ask to edit external
files"*, it created a file outside its working directory without asking.

Quintal's approval cards cannot reach this runtime. An agent running on Codex
is governed by Codex's own approval policy and sandbox settings, and nothing
in Quintal changes that — with or without the `run` scope.

### opencode 1.4.3

Never sent `session/request_permission` in either mode (`build`, `plan`), for
any of the three probes. Its own `permission` configuration decides.

### Gemini CLI 0.46.0

Not established. `session/new` failed on the probe machine with "Gemini API key
is missing or not configured", so nothing could be asked. It stays `unknown`,
which means its options would not be offered on a card.

### Goose

Not established — not installed on any machine probed so far.

## Grants Quintal cannot revoke

Quintal never creates a persistent grant, so it has none to list or remove.
What it can do is be honest about the ones it does not control:

- **Claude Code** keeps allow rules in `~/.claude/settings.json` and a
  project's `.claude/settings.local.json`. Quintal neither reads nor writes
  them; they are managed with the `claude` CLI.
- **Codex** decides from its own approval policy and sandbox settings
  (`~/.codex/config.toml`).
- **opencode** decides from its own `permission` configuration.

This is why withdrawing an agent's `run` scope says what it says. Turning
`run` off stops *Quintal* answering the runtime's questions from that agent's
next session. It does not reach inside the runtime, and a rule kept there is
still in force. Reporting that as "revoked" would be the same false promise
this document exists to remove, pointed the other way.

## Saying it on the screen

Two of the runtimes above never ask, and the person who needs to know that is
the owner setting scopes in a browser — not the harness's stdout, which is
where the fact used to stop. So `asks` is surfaced wherever an owner makes a
decision that depends on being asked:

- the scopes editor in **Settings → Agents**, under the `run` checkbox,
- the agent's row in that list, as a short `never asks` label,
- and the agent's card in the office, on an `asking` row.

One helper decides the words: `apps/web/src/lib/runtime-asking.ts`. It reads
the catalogue by `runtimeId` and returns nothing at all for a `verified`
runtime, for an agent the office does not define, and for an id it has never
heard of — a warning about an unmeasured runtime would be its own unfounded
claim.

`never_observed` and `unknown` read differently on purpose. "We drove it end to
end and it never asked" is a fact an owner must act on; "we have not
established this" is not. Gemini and Goose are `unknown` today, and they get
the weaker line.

The withdrawal notice says it too. Taking `run` away from an agent on Codex
changes nothing observable — there was never a question routed through Quintal
to stop answering — so that case gets
`RUN_SCOPE_WITHDRAWAL_NOTE_NEVER_ASKS` and every other case keeps the general
wording, `unknown` included.

None of this blocks or hides anything. An owner may run an agent on a runtime
that never asks; they simply should not be able to believe Quintal is gating
it. Quintal cannot make Codex ask, and does not pretend to.

## Re-establishing it

The catalogue is data with a date against every entry. When an adapter
changes, re-record rather than reason:

```sh
pnpm exec tsx packages/acp-harness/scripts/probe-permissions.mts             # all runtimes
pnpm exec tsx packages/acp-harness/scripts/probe-permissions.mts claude-code # one
pnpm exec tsx packages/acp-harness/scripts/probe-grant-lifetime.mts omp - shell
pnpm exec tsx packages/acp-harness/scripts/probe-grant-lifetime.mts claude-code default write
```

The first never answers anything but `cancelled`. The second **does** take one
standing grant, in a disposable workspace, and reports every runtime config
path whose fingerprint moved while it ran — that is how "where does this
persist?" gets an answer. Back those paths up before running it.

Then update `packages/shared/src/runtime-permissions.ts`, re-record
`packages/acp-harness/test/fixtures/runtime-options.json` from the probe
output, and update this page. The tests read the fixtures, so an adapter that
renames an option id fails them loudly rather than quietly widening a grant.
