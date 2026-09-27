# QUIN-73 verification — 2026-09-27

Implementation and checks ran on the `ys/quin-73-restale-runtime-probe` branch
on macOS 26.5.2 (Darwin 25.5.0), Node 24.13.0, Apple Silicon, from main
`1ed8f8f` (merge of #123). No office was booted and no runtime was spawned:
every check here is static or a unit test. See "What was not verified" below —
that is the substantive gap.

## What was decided

The ticket left the version-mismatch policy open and listed four options. The
owner chose **degrade to kind semantics** — the ticket's own recommendation —
because it lands on the path an uncatalogued runtime is already on rather than
adding a second degraded mode to reason about.

Implementing it turned up one thing the option as written does not survive,
and the shape changed slightly as a result. See "The hole the tests found".

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, server, web, harness, website, root |
| `pnpm build` | Pass — shared, harness, web, server |
| `pnpm --filter @quintal/shared test` | Pass — **441 tests**, 0 fail (19 new) |
| `pnpm --filter @quintal/web test` | Pass — **235 tests**, 0 fail (2 new) |
| `pnpm --filter quintal-acp test` | Pass — **323 tests**, 0 fail (2 new) |
| `pnpm --filter @quintal/server test` | Pass — 113 tests, 0 fail |
| `pnpm test:release` | Pass — 12 tests |
| `node scripts/check-client-manifest.mjs` | Pass — 24 boundaries, 23 route manifests |
| `git diff --check` | Pass (exit 0) |
| NUL-byte scan of all 14 changed files | Pass — 0 NUL bytes |

No existing test had to change. Every new parameter is optional and trailing,
so all 743 pre-existing assertions kept their meaning: an absent `observed`
adapter means "did not look", which trusts the catalogue exactly as before.

## The hole the tests found

The chosen policy, taken literally, re-opens the bug QUIN-53 closed.

Degrading to kind semantics means falling back to `SPEC_DEFAULTS`. Claude
Code's `exit-plan-default` carries ACP kind `allow_once` while really being a
session-policy switch — that mismatch is the whole reason the catalogue
exists. Fall back to its kind and the spec default makes it per-call, so the
`run` scope takes it automatically and the card labels it "Allow once".

This was caught by the fixture-driven test asserting the degraded path refuses
it, which failed on the first run with `actual: 'exit-plan-default'`.

The fix is an asymmetry, now the load-bearing part of the policy: **stale
evidence cannot license an allow, but it can still license a refusal.** A
catalogued option id measured as broader than per-call stays unofferable even
when the profile is otherwise distrusted — a version bump is no reason to
believe a grant got *narrower*.

The asymmetry is keyed on the option id, so a **rename escapes it**. Review
correctly caught that the first version of this doc called that escape "the
safe direction"; it is only safe when the renamed id's kind is honest. See
"What this still cannot see" below.

`packages/shared/src/runtime-permissions.ts` carries the reasoning at the
branch; `runtime-permissions.test.ts` asserts it against every non-per-call
option in the catalogue, not just the one that failed.

## Review round

Two reviewers approved. Three line comments, all non-blocking, all addressed:

1. **The "safe direction" claim was false** (above). Corrected in the code
   comment, `docs/RUNTIME-PERMISSIONS.md` and this file, with a
   failing-by-design test.
2. **The worker warned on expiry too**, so every worker of every office would
   log the same nag on every restart once the window passed — about a debt
   this repository owes, not anything wrong on that machine, and contrary to
   this PR's own policy. Now `version_moved` only, matching the settings page.
3. **The supervisor's `adapter: null` guard** collapses "asked, did not say"
   into "not asked". Kept — it buys last-known-wins on a re-probe that fails
   to handshake — and now says so in a comment.

Also from review: a worker that handshakes without naming itself now warns,
bounded to profiles that name an adapter so an unmeasured runtime stays quiet;
and `runtimes.test.ts` pins `normaliseAdapter`'s three-way distinction.

One review point was **not** acted on: that codex and opencode have catalogued
options with no fixture tie. Both have zero catalogued options
(`options: []`), so there is nothing to tie.

## Expiry does not degrade a live office

The ticket asked for a staleness window. It is 183 days, and it fails the
catalogue test rather than changing runtime behaviour.

Making expiry degrade live would mean an owner's Allow buttons narrowing one
morning because a date passed, with no adapter having moved and nothing in the
tree different. An unrefreshed measurement is a debt this repository owes, not
a fact about the runtime on somebody's laptop. `verificationExpired` is
exported and used by the reporting view (`profileStaleness`) and the test;
`optionSemantics` calls `adapterMoved` alone.

**This test will start failing around 2027-03-26**, when the 2026-09-24
entries pass the window. That is the forcing function working, not a break.
The failure message names the runbook.

## What was verified, and how

- **Mismatch detection.** Same adapter → no signal; bumped version → signal
  naming both sides; renamed adapter at the same version → signal; unobserved
  → no signal. A profile with nothing measured (`goose`) can never go stale.
- **The degraded state is usable.** `allow-once` still resolves through the
  spec default to a per-call Allow labelled "Allow once". Checked on the real
  recorded payloads in `runtime-options.json`, not invented ones.
- **The degraded state is safe.** Every non-per-call catalogued option stays
  unofferable; the plan-exit card degrades to Deny alone; the `run` scope's
  automatic path refuses with `unexplained_allow`.
- **Equivalence with the uncatalogued path.** For an unrecognised option id,
  a stale `claude-code` and a never-probed runtime return the identical
  answer for `allow_once`, `allow_always` and `reject_once`.
- **Fixture and catalogue cannot drift.** A test ties each fixture's `_agent`
  to that profile's `verifiedAgainst`. Sabotage: bumping `_agent` in
  `runtime-options.json` without touching the catalogue fails it, naming both
  sides. Confirmed by hand before reverting the edit (file copied aside, not
  `git checkout`).

## What was not verified, and why

**No runtime was spawned.** Everything above is unit-tested against recorded
payloads. The three live paths are unexercised:

- The worker's start-up warning (`#warnIfAdapterMoved`) has never printed
  against a real handshake. Its inputs are tested; its wiring is not.
- `probe-permissions.mts --check` and `--write-fixture` have never been run.
  They spawn real runtimes and cost model calls, which the ticket puts out of
  CI deliberately and which this session had no mandate to do.
- The amber drift line in Settings → Agents has not been seen rendered. It is
  reached only from a `HostReport` carrying an `adapter` that disagrees with
  the catalogue, which needs a fleet.

The honest way to close all three is one local run of
`probe-permissions.mts --check` against an installed Claude Code, and a fleet
boot with a deliberately wrong `verifiedAgainst`. Neither was done.

### What this still cannot see

Two gaps, both uncloseable from the payload, each with a failing-by-design
test in `runtime-permissions.test.ts` and a section in
`docs/RUNTIME-PERMISSIONS.md`.

- **The limit the ticket names.** An option id that keeps its name and widens
  its meaning under the same version: the difference is in behaviour, not in
  the payload.
- **A renamed option whose kind lies** — found in review, not by me. A moved
  adapter that renames `exit-plan-default` while keeping kind `allow_once`
  falls through the id-keyed asymmetry to the spec default, becomes an
  offerable per-call allow, and is taken automatically by the `run` scope.
  Confirmed by hand against the built package before the test was written.
  Refusing every unrecognised `allow_once` would close it and would also kill
  "degraded, not dead" for plain renames, so it stays open and stated.

Both are bounded the same way: the meaning can only drift under a release,
and a release that moves the version stops the catalogue being trusted at
all. Re-probing is what actually closes either.
