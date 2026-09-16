# QUIN-55 verification

Implementation is on `activity-detail-levels`, based on refreshed `origin/main`
at `bf9a46f`. The verification plan was approved on 2026-09-16 and executed in
the same worktree against a production build on port 3055 with a disposable
SQLite database and object store under `/tmp/quin55-verification.RAlJKZ`.

The change adds a database-backed per-user activity detail preference with
Balanced as the schema and application default. The browser and desktop webview
receive the same server-rendered value. An account-scoped browser notification
lets an already-open office reflect a save from Settings without modifying the
retained turn snapshots, message identities or ACP event stream.

## Automated checks

| Check | Result | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | Pass | All workspace packages passed. |
| `pnpm build` | Pass | Shared, harness, web and server production builds completed. |
| `pnpm --filter @quintal/shared --filter @quintal/web test` | Pass | Shared: 391/391; web: 168/168, including preference default/isolation and presentation projections. |
| `pnpm db:generate` | Pass | `No schema changes, nothing to migrate`; the checked-in migration and snapshot match the schema. |
| `node scripts/check-client-manifest.mjs` | Pass | 22 client boundaries expected; 23 route manifests checked. |
| `git diff --check` | Pass | No whitespace errors. |

The repository has no root lint script, so no standalone lint command was
invented; the relevant TypeScript, build and test commands cover the changed
packages.

## Smoke checks

- `node scripts/smoke.mjs http://127.0.0.1:3055` passed the public, identity,
  authenticated office and Settings route checks; the captured responses are in
  `http-smoke.log`.
- The fresh database applied migration `0031_user_activity_detail.sql`. SQLite
  reported `activity_detail_level TEXT NOT NULL DEFAULT 'balanced'`.
- A fresh browser identity rendered Balanced by default. Changing that identity
  to Low survived a reload and a fresh tab. A second identity remained Balanced;
  direct database rows showed the two different values for the same office.
- The QUIN-49 protocol smoke passed twice (browser and desktop identities): 17
  received snapshots, zero visibility leaks, zero agent wakeups, restricted
  history denied, and completed, failed, cancelled and disconnected states
  retained. Queue delivery measured 146 ms and 118 ms respectively.
- Low, Balanced and Detailed were inspected in the browser for retained and live
  turns. Balanced reported `3 completed · 2 succeeded · 1 failed · 0 unknown`;
  Low kept the failed row and final reply visible; Detailed showed all steps,
  durations and expandable sanitized results.
- Switching Low → Balanced → Detailed preserved the same three turn IDs and
  ordering without duplication. The pinned compact transcript kept the same
  159.5 px bottom gap as its height changed. A full transcript scrolled to the
  top remained at `scrollTop = 0` when switching Detailed → Balanced.
- Channel and DM history were inspected. A retained DM fixture with an explicit
  unknown tool reported it as unknown rather than success; because no runtime
  remained connected, the server honestly closed its running step and turn as
  interrupted. The live waiting presentation (`Waiting for your input.` at all
  levels) was confirmed in the unconditional rendering path; there was no
  QUIN-52 approval-card implementation on this base revision to exercise.
- The macOS desktop webview connected to the same isolated server. Its Profile
  screen rendered the three-way control with Balanced selected by default; a
  separate desktop user saved Low, while the browser user remained Balanced.
  The desktop channel then showed the compact Low view with the failure and
  final reply visible.
- Browser-console inspection found no application errors. The only app-origin
  warning was the existing Colyseus `channels` handler warning; the remaining
  warnings came from a browser extension.

Screenshots were captured during the browser and native desktop inspection in
the computer-use session. Machine-readable local evidence is in
`/tmp/quin55-verification.RAlJKZ`: `db-default.txt`,
`db-low-isolation.txt`, `http-smoke.log`, `protocol-report.json`, `protocol-smoke.log`,
`live-stream.log`, `desktop-protocol.log`, and `dm-waiting-fixture.json`.

## Explicit gaps

- No production deployment or unrelated runtime/integration check was run; the
  task explicitly limits verification to the local implementation environment.
- A second physical browser device was not used. Durable per-user isolation was
  instead verified with independent browser and desktop identities plus their
  database rows.
