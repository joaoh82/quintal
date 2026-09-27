# QUIN-57 verification — 2026-09-27

Stage 1 of the personal office, implemented and checked on the
`ys/add-standalone-personal-office` branch on macOS 26.5.2 (Darwin 25.5.0),
Apple Silicon, Node 24.13.0 (build host), pnpm 11.0.9, Rust 1.94.0, from
main `ce386b8` (merge of #125). One platform only: see "What was not
verified" — every other release target is wired but unproven here.

## What was delivered

The app now offers two answers on its first screen — **Create a personal
office** and **Connect to a server** — and the first one works with nothing
installed. The personal office is the production server (`apps/server`,
Next.js and Colyseus in one Node process) started and supervised by the
desktop host on a loopback port, with its data under the app data directory.
Nothing about the server or the web app was reimplemented.

| Piece | Where |
| --- | --- |
| Owner-only personal mode in the server: one key may sign in, no guest links | `packages/shared/src/personal.ts`, `apps/web/src/lib/auth/keypair.ts`, guest actions and pages, `/api/office` |
| The payload: server + web app + runtime closure, one flat tree | `apps/personal-payload/package.json`, `scripts/build-personal-payload.mjs` |
| The pinned Node runtime as a Tauri external binary | `scripts/fetch-node-runtime.mjs` |
| Signing the payload's native code on macOS | `scripts/sign-payload.mjs`, `entitlements.plist` |
| The supervisor: port, lock, secret, backup, spawn, readiness, restarts, stop | `apps/desktop/src-tauri/src/personal.rs` |
| The choice, the grant, the commands, the bootstrap page | `server.rs`, `commands.rs`, `lib.rs`, `build.rs`, `bootstrap/index.html` |
| Web: stable slot for credentials, personal row, guest screens | `host.ts`, `Servers.tsx`, `WhichServer.tsx` |
| Release wiring | `tauri.personal.conf.json`, `tauri.bundle.conf.json`, `build-desktop-release.mjs`, `bundle-desktop.mjs`, `fix-appimage.sh`, `release.yml` |
| End-to-end proof against the real bundle | `scripts/personal-office-smoke.mjs` |

## Decisions taken

- **Owner named before the server starts.** `QUINTAL_PERSONAL_OWNER` is the
  app's own public key. Loopback is not access control; without this the
  first local process to sign in would own the office.
- **Stable identity by word, not URL.** Credentials for the personal office
  are filed under `personal`; the loopback port may move and the office is
  the same office. Sessions are host-bound, so they survive a port change.
- **Close = quit; no background mode in Stage 1.** Documented in DESKTOP.md.
- **The server watches the pipe.** `QUINTAL_EXIT_WITH_PARENT=1` makes the
  server stop on stdin EOF, the harness's contract. Found by the smoke below:
  before it, a force-quit app left its server running on the port.
- **`next.config.ts` compiled at build.** Otherwise Next needs `typescript`
  and the SWC native binary at runtime and *downloads* them when absent —
  observed on the first payload boot. Both are pruned; ~150MB saved.
- **Three restarts in five minutes, then report** with the exit code and the
  server's last stderr lines, the backup taken, and the data directory.
- **Backup on version change only**, five kept, recovery by copying back.

## Automated checks

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — shared, server, web, harness, website, root |
| `pnpm build` (shared, harness, web, server) | Pass |
| `pnpm --filter @quintal/shared test` | Pass — 444 tests (3 new: `personal.test.ts`) |
| `pnpm --filter @quintal/web test` | Pass — 239 tests (4 new in `keypair.test.ts`: owner admitted as admin, stranger refused on an empty database, guest link refused, nothing refused without an owner) |
| `pnpm --filter @quintal/server test` | Pass — 113 tests |
| `pnpm test:release` | Pass — 12 tests; the new workspace package is picked up by the manifest walk |
| `cargo fmt --check` | Pass |
| `cargo clippy --all-targets -- -D warnings` | Pass |
| `cargo test` (desktop host) | Pass — 147 tests, 18 of them new in `personal.rs` and `server.rs`: port never 3000 or privileged, preferred port kept or replaced, loopback origin, private secret minted once, record id stable, plan pins loopback/data/owner and carries no secret, backup on version change and rotation, lock admits one, payload/runtime location refusals, crash-loop gives up with last words; personal choice survives the URL filter, personal grants only for the picker and the office |
| `node scripts/check-client-manifest.mjs` | Pass — 24 boundaries, 23 route manifests |
| `git diff --check`, NUL-byte scan of every changed file | Pass |
| `node scripts/build-personal-payload.mjs` (host triple) | Pass — see measurements; boots on the bundled Node, answers `/health`, `/login` 200, `/api/office` `personal: true`, challenge bound to its origin, no runtime download, no write into the payload, stops on stdin EOF |
| `node scripts/fetch-node-runtime.mjs` | Pass — SHA-256 verified, `--version` answers `v22.23.3` with only `/usr/bin:/bin` on PATH |
| `node scripts/desktop-ipc-check.mjs` (debug build, remote origin) | Pass — 46 commands answer as expected, signature verifies with @noble/curves; the three new personal commands are refused from a server origin by the ACL |

Every row above ran twice: once as the implementation settled, and once more
as the formal pass on the committed tree after the plan was approved. Both
runs were green.

## Smoke: the real bundle

`tauri build --bundles app` with the sidecar and personal configs, ad-hoc
signed, under a throwaway bundle identifier so the user's own Quintal data was
never touched, driven by `scripts/personal-office-smoke.mjs` in a throwaway
`HOME` with the file secrets backend:

```
  ok   the office comes up on a loopback port — http://127.0.0.1:61075 in 6625ms
  ok   the port is not 3000 — 61075
  ok   the server listens on 127.0.0.1 only — 127.0.0.1:61075
  ok   the server knows it is a personal office — {"name":"","personal":true}
  ok   the login page renders — HTTP 200
  ok   a stranger is refused, even on an empty database — HTTP 403: This is a personal office. Only its owner can sign in here.
  ok   the owner signs in — HTTP 200
  ok   a guest link is refused at the door — the join page says so
  ok   the database, objects, secret and lock live in the data directory — auth-secret, office.json, office.lock, quintal.db, quintal.db-shm, quintal.db-wal
  ok   the session secret is private — mode 600
  info measured: cold start 6625ms; RSS app 105MB, server 185MB
  ok   a second launch exits and leaves the first alone — second exited with 0
  ok   a killed server is restarted on the same port — new pid 3716 after 1647ms
  ok   the owner is still the owner after the restart
  ok   a force-quit app takes its server with it — app exited after 202ms; server gone 66ms later
  ok   the lock is released
  ok   the next launch keeps the port — http://127.0.0.1:61075 in 1660ms
  ok   the office id is stable
  ok   the owner comes back to the same account — user 153a2e12-2383-4671-90fa-4175ddfa04ac
  ok   no backup is taken when the version has not changed — 0 backups
  info measured: warm start 1660ms

PASSED: 19/19 checks
```

The formal re-run on the committed tree passed the same 19 checks (cold
start 2.6s, warm 1.6s, server RSS 188MB, app 106MB; the server gone 64ms
after a force-quit).

The first run of this smoke, before the server watched its stdin, failed
"quitting stops the server": the app exited on SIGTERM and its Node child kept
listening on the port, and the next launch found that orphan answering
`/health` in 2ms. That is the finding that added `QUINTAL_EXIT_WITH_PARENT`
to the server; the payload smoke now stops the server by closing its stdin
rather than by signal, so the contract is proven at build time too.

## Measurements

| What | Value |
| --- | --- |
| Payload on disk (macOS arm64, pruned) | 408MB, 24,703 files — `phaser` 140MB and `next` 133MB are two thirds; both are candidates for trace-based pruning later |
| Node runtime | 108MB |
| Harness sidecar | 58MB |
| `Quintal.app`, uncompressed, ad hoc | 663MB (was ~90MB); DMG compression not measured here |
| Payload cold start to `/health` (bundled Node, fresh database, migrations) | 2.0s in the payload smoke; 2.4s and 6.4s across launches of the bundle |
| Warm relaunch to `/health` | 2.4s |
| Idle RSS after ready | server ~180–190MB, app ~108MB |
| Restart after `kill -9` of the server | back on the same port in 1.8s |

No budgets are set yet; the ticket asks for measurement first. Installer size
is the number that needs a decision before a broad release.

## What was not verified

- **Any platform but macOS arm64.** Linux (AppImage, .deb) and Windows are
  wired — the runtime fetch, the payload's native-module swap, the AppImage
  repack — and none of it has run. The native swap for a cross-target has
  only been exercised by unit-level reasoning about the lockfile, not by
  building an Intel payload and running it under Rosetta.
- **A Developer ID signed, notarized bundle** with the payload. Ad-hoc
  signing plus the library-validation entitlement is what ran here. That
  notarization accepts the re-signed payload is expected, not shown.
- **Migration failure recovery in anger.** The backup path is unit-tested and
  the failure report is unit-tested with a fake server; nobody ran a broken
  migration against a real office and restored from the backup.
- **Agents in a personal office.** The fleet path is unchanged and unit-tested
  against the new slot key; no harness was spawned against the bundled server.
- **Sleep/wake.** Documented as "the process pauses with the machine"; not
  exercised.
- **The website** (`apps/website`) still describes the Docker-first flow;
  it documents the shipped release and should change with the release.

## Follow-ups worth filing

1. Trace-based payload pruning (`.next/**/*.nft.json`) — `phaser` and
   `lucide-react` are client bundles the server never loads; likely ~180MB.
2. Run `personal-office-smoke.mjs` in the release workflow on macOS (it needs
   a display; the runner has one) and a Linux variant under xvfb.
3. Stage 2: guided agent install/auth inside the app.
4. Close-to-tray / background office, once wanted.
