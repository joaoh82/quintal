# QUIN-4 — a standalone office will not start on Windows: `lstat 'C:'`

The test plan below was approved before execution. Everything here ran on
Linux x86_64 (Arch, kernel 7.2) in the implementation worktree, based on main
`f3e3e5b`, with stable Rust and Node 26.7.0 on the host; the bundle under test
carries its pinned Node 22.23.3. There is no Windows machine in this
environment: the Windows-only tests ran in CI's `windows_tests::` step, on
the fix and — after review — on the fix sabotaged back to v0.6.4.

## What was wrong

The ticket's reasoning was right about the JavaScript and missed one layer
below it. Every `binding.lstat` on Windows passes its path through Node's
**C++** `ToNamespacedPath` (`src/path.cc`), which re-resolves it with a C++
port of `path.win32.resolve`.

1. Tauri canonicalizes the executable, and on Windows `resource_dir()` *is*
   the executable's directory — so it is verbatim, `\\?\C:\Users\…\Quintal`,
   and the entry built on it is `\\?\C:\…\personal\node_modules\@quintal\server\dist\index.js`.
2. `realpathSync` splits off the root, `\\?\C:\`, and lstats it first. (JS
   side correct, as the ticket says.)
3. `ToNamespacedPath` reads `\\?` as the device (`rootEnd = 4`) and `C:\` as
   a tail. Normalizing the tail drops its trailing separator: what reaches the
   OS is `\\?\C:` — the volume, not its root directory. EISDIR.
4. Node prints error paths with any `\\?\` stripped
   (`src/api/exceptions.cc`, `StringFromPath`). So: `lstat 'C:'`, from a path
   that had a root all along.

No Quintal code runs before this, and nothing about the data directory, the
environment or the payload tree is involved. Every Windows install hits it.

## The fix

`personal::anchored` — already applied to both payload routes by PR #142 —
now also runs `dunce::simplified` after `std::path::absolute`. That strips a
`\\?\C:\` prefix wherever the plain path names the same file (≤ 260 chars, no
reserved names), and is the identity off Windows. The runtime found beside
the executable goes through it too. `entry` and `web_dir` are both joined onto
the anchored payload directory, so the `\\?\` reaching `QUINTAL_WEB_DIR` and
Next, set aside in the ticket as a separate problem, is gone by the same
change. `dunce` 1.0.5 was already in the lockfile through Tauri.

Where `dunce` must keep the prefix — the plain spelling over 260 characters,
a reserved name, a trailing dot — `locate_payload` refuses the payload as
`PersonalError::VerbatimPath` (host code `install_path`), naming the path,
instead of handing Node a verbatim entry to fail on unreadably. Added after
review.

## Checks

| # | Check | Result |
|---|---|---|
| 1 | Sabotage: `anchored` removed from both routes, `a_payload_under_a_rootless_resource_dir_is_rooted_too` run | **failed as it must**: `handed to the server rootless: .tmpo8UVBO/personal/node_modules/@quintal/server/dist/index.js`; file restored |
| 2 | Node-level replay, [`node-replay/run.sh`](./node-replay/run.sh) → [`node-replay.txt`](./node-replay.txt) | v0.6.4 entry: **the reporter's exact error**, `errno: -4068, code: 'EISDIR', syscall: 'lstat', path: 'C:'`. Fixed entry: resolves in 12 lstats |
| 3a | Windows target `cargo check --tests --target x86_64-pc-windows-msvc` | **not possible here**: `ring`'s build script needs the Windows CRT headers (`assert.h` not found, with `clang-cl`/`llvm-lib` as well) |
| 3b | The Windows test with `cfg(windows)` lifted, its `\\?\`-only precondition dropped and its separators made `/`, on Linux | **pass** — compiles, and spawns real Node from `plan()`'s args, cwd and env; file restored afterwards |
| 4 | `cargo test --locked` (desktop crate) | **pass** — 164 passed, 0 failed, 1 ignored ([`unit-tests.txt`](./unit-tests.txt)) |
| 5 | `cargo clippy --locked --all-targets -- -D warnings`; `cargo fmt --check` | **pass**; fmt clean after `cargo fmt` wrapped the new lines |
| 6 | JS lint / typecheck | not run — no JS or TS changed; the desktop CI gates for this change are 4 and 5 |
| 7 | `personal-office-smoke.mjs` against a real bundle ([`office-smoke.txt`](./office-smoke.txt)) | **pass — 19/19** |
| 8 | PR CI, `windows` job, on the fix | **pass** — `personal::windows_tests::a_verbatim_resource_dir_still_starts_the_server ... ok` on the bundled Node 22.23.3 |
| 9 | Windows CI with the fix sabotaged back to v0.6.4 — prefix kept, guard off — on a throwaway branch, since deleted ([run](https://github.com/joaoh82/quintal/actions/runs/37237506829/job/111539474544), [`windows-sabotage.txt`](./windows-sabotage.txt)) | **failed as it must**: the bundled Node 22.23.3 exits 1 with the reporter's stack, headed `Error: EISDIR: illegal operation on a directory, lstat 'C:'` at `node:fs:2749` — `realpathSync`'s root lstat. The over-260 test fails too: without the guard the path falls through to a generic `NoPayload` |

### The replay (2)

Node v22.23.3's `realpathSync` from `lib/fs.js` and `path.win32` from
`lib/path.js`, unmodified, with `binding.lstat` routed through
`ToNamespacedPath` from `src/path.cc` compiled as its Windows branch against
small stubs. The one modelled fact is Windows' own: lstat of the bare volume
`\\?\C:` answers EISDIR — which the reporter's stack confirms.

```
== v0.6.4: entry on Tauri's resource_dir
   first lstat: \\?\C:\  ->  \\?\C:
   THROWS  EISDIR: illegal operation on a directory, lstat 'C:'  { errno: -4068, code: 'EISDIR', syscall: 'lstat', path: 'C:' }

== fixed: entry after dunce::simplified
   first lstat: C:\  ->  \\?\C:\
   resolves to C:\Users\me\AppData\Local\Quintal\personal\node_modules\@quintal\server\dist\index.js  (12 lstats)
```

That `dunce::simplified` turns the first into the second was read from its
source (`Prefix::VerbatimDisk`, length and reserved-name checks), not run —
it is the identity off Windows.

### The smoke (7)

Built as CI's Linux packaging job does — harness sidecar, pinned runtime,
`build-personal-payload.mjs` (which booted the payload: `ready in 1169ms;
/login 200; personal office`) — then `tauri build --bundles deb` with
`tauri.bundle.conf.json`, `tauri.personal.conf.json` and
`tauri.release.conf.json`. The `.deb` was unpacked in place rather than an
AppImage assembled: the same packaged layout, resolved by Tauri through
`../lib/Quintal` with `quintal-node` beside the binary, without linuxdeploy.
Run under `dbus-run-session` so the single-instance plugin could not hand off
to an installed Quintal.

```
  ok   the office comes up on a loopback port — http://127.0.0.1:35673 in 1732ms
  ok   a stranger is refused, even on an empty database — HTTP 403: This is a personal office. Only its owner can sign in here.
  ok   a killed server is restarted on the same port — new pid 1579781 after 1676ms
  ok   the next launch keeps the port — http://127.0.0.1:35673 in 1193ms
PASSED: 19/19 checks
```

## Regression test

`personal::windows_tests::a_verbatim_resource_dir_still_starts_the_server`
canonicalizes a temporary directory (so it *is* `\\?\`), lays a payload
under it with the manifest's forward-slashed `entry`, runs `locate_payload`
and `plan()`, and starts the bundled `quintal-node-x86_64-pc-windows-msvc.exe`
— the reporter's Node 22.23.3, which CI fetches before this step — from the
office's data directory exactly as the supervisor does, before comparing any
strings, so a regression fails with what Node said. Observed both ways on
Windows CI (checks 8 and 9): with the fix it prints and exits 0; with v0.6.4's
anchoring Node dies with the reporter's `lstat 'C:'`. It runs in
`packaging.yml` and `release.yml` under the existing `windows_tests::` filter.

`personal::windows_tests::a_resource_dir_that_must_stay_verbatim_is_refused_by_name`
builds a resource directory past 260 characters, which `dunce` must leave
verbatim, and expects `VerbatimPath` naming it.

`personal::tests::a_payload_under_a_rootless_resource_dir_is_rooted_too`
covers the resource-dir route on every platform, which had no test.

## Not verified

- An NSIS install on Windows — no Windows machine here; the Windows CI test
  stands in for it.
- `scripts/personal-office-smoke.mjs` on Windows: it still skips there
  (QUIN-75), which is why CI never saw this.
- An *installed* app at a path over 260 characters. The refusal is unit-tested
  on Windows CI, but not seen in the bootstrap page.
