# QUIN-77 — restoring a personal office from its backup

The test plan below was approved before execution, with the bundle build
excluded by agreement. Every approved check passed on macOS arm64 (Darwin
25.5.0) in the implementation worktree, based on main `fa8bafc`, using the
repository's pinned Rust toolchain and Node 24.13.0.

QUIN-57 took a backup before every upgrade and named it on the screen that
reports a failure. Putting it back was a paragraph in `docs/DESKTOP.md` about
copying files around with the app shut — a recovery path for a developer. This
ticket makes it a button, and makes the host refuse it in the one case where
pressing it would destroy data rather than save it.

## What the recovery does

1. The database the failed run left behind is **moved**, not deleted, to
   `backups/<stamp>-failed-<version>/`.
2. The backup's `quintal.db`, `-wal` and `-shm` are copied back. All three
   travel together in both directions.
3. `office.json` records the version the database now belongs to and the
   backup it came from, so relaunching the version that failed does not copy
   the same bytes aside again and push the copies that matter out of the five
   that are kept.
4. The office is left **not running**, with a message saying that this is
   still the version whose migration failed and naming the version to install.
   A restore is not a rollback, and pretending otherwise would send somebody
   back into the same failure.

`restore_personal_backup` takes no arguments: the page cannot name a path, and
the office restores only the backup *it* recorded for this launch. It is
refused unless the launch failed **before the office ever opened**, so the
office's own page — which by definition opened — can never reach a database to
overwrite, grant or no grant.

## Approved automated checks

- `cargo fmt --check` and `git diff --check` — pass, no output.
- `cargo clippy --all-targets -- -D warnings` — pass, no warnings.
- `cargo test` (desktop host) — **154 passed, 0 failed, 1 ignored**; 7 new,
  listed below. Full run in [`unit-tests.txt`](unit-tests.txt).
- `node --check` on the bootstrap page's inline module, extracted — pass. No
  JavaScript linter is configured for that file.

### New tests

| Test | What it pins |
|---|---|
| `a_restore_puts_every_file_back_and_keeps_the_one_that_failed` | `quintal.db`, `-wal` and `-shm` all come back; the half-migrated database is kept, not deleted; the version is read out of the backup's name |
| `a_wal_the_backup_does_not_have_is_not_left_behind` | A `-wal` from the failed run does not survive a restore — SQLite would replay it onto bytes it was never written against |
| `a_restored_database_is_not_backed_up_again_until_the_office_opens` | The record says the database came from a backup; the next launch of the failed version copies nothing and offers the same directory |
| `only_this_office_s_own_backups_are_restored` | A directory outside `backups/`, and one inside it with no database, are refused; the live database is untouched |
| `a_backup_name_says_which_versions_it_sits_between` | `<stamp>-<from>-to-<to>` parses; a `-failed-` directory and a hand-made name do not |
| `an_office_that_has_not_failed_restores_nothing` | Refused while starting, and refused for an office that came up with a backup recorded — the shape a page in a working office would call from |
| `a_failed_migration_is_undone_from_the_screen_that_reports_it` | End to end, against a stand-in server that writes over the database and exits 1 with a migration error: the app gives up, the status is restorable, the restore puts the office back including the WAL, names 0.4.0 to install, and a second press is refused |

## Approved smoke checks

The real `apps/desktop/bootstrap/index.html` was served over loopback with a
stand-in for the Tauri bridge — the page itself unmodified — and driven in
Chrome. Screenshots are beside this file.

| Check | Evidence |
|---|---|
| A failed office with a backup offers the restore, labelled with the backup's date | [`failed-with-restore.png`](failed-with-restore.png) — "Restore the backup from 2026-09-28 14:15 UTC", beside **Try again** |
| Pressing it warns first, then shows the restored state | [`after-restore.png`](after-restore.png) — headline "Your office is back as it was before the upgrade", the message naming Quintal 0.4.0 to install and where the failed database is kept, and no restore button. Read back from the page: `{"confirmed":true,"restoreHidden":true,"phase":"restored"}` |
| A failure with no backup, or one the host will not restore, offers nothing | [`failed-without-backup.png`](failed-without-backup.png) — **Try again** and **Connect to a server instead** only |

One layout correction came out of this: three buttons, one carrying a date, do
not fit on one line in that window, and the row was wrapping labels mid-word.
The row wraps now; the labels do not.

## Approved sabotage checks

Each sabotage was applied to the working tree, the suite run, and the change
reverted.

| Sabotage | Result |
|---|---|
| `restore_backup` copies only `quintal.db`, never `-wal` or `-shm` | **3 tests fail.** `a_restore_puts_every_file_back…`: `left: "half migrated wal", right: "rows not yet checkpointed"` — the rows written after the last checkpoint are exactly what goes missing. `a_wal_the_backup_does_not_have_is_not_left_behind`: "a WAL from the failed run must not survive the database it belongs to". The end-to-end test fails on the same assertion |
| The `restored_from` guard is removed from `backup_before_upgrade` | **1 test fails:** "nothing was copied: it is the same bytes" — every relaunch of the failed version would copy the restored database aside again |
| `Office::restore` checks only that a backup exists, ignoring whether the office ever opened | **2 tests fail** — the refusal test and the second press in the end-to-end test. The first run of this sabotage only failed the second of those, so `an_office_that_has_not_failed_restores_nothing` was extended to drive a *ready* office with a backup recorded, which is the case that matters |

## Not verified

- **The bundled app against a real failed migration.** Excluded from this run
  by agreement: it needs two signed bundles either side of a version bump and
  a deliberately broken `packages/shared/drizzle/9999_*.sql`. The end-to-end
  Rust test drives the real supervisor against a real child process that
  writes over the database and dies with a migration error on stderr, which is
  the same code path from `backup_before_upgrade` through the crash budget to
  the restore; what it does not prove is that a Drizzle migration failure
  actually kills the server rather than letting it come up degraded. Worth a
  follow-up before the next release that carries a migration.
- **Linux and Windows.** Host-only run. The restore uses `std::fs::rename`
  with a copy fallback and nothing platform-specific; QUIN-76 tracks platform
  verification.
- **`scripts/personal-office-smoke.mjs`** (19 checks) — needs a fresh bundle,
  and none of its checks touch upgrade or restore.
- **`pnpm typecheck` / `pnpm build`** — no TypeScript, web or server file
  changed.
