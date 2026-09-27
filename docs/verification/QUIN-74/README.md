# QUIN-74 — personal payload trace pruning

The test plan below was approved before execution. All approved checks passed
on macOS arm64 in the implementation worktree, based on main `2840db3`, using
Node 24.13.0 and pnpm 11.0.9. The payload ran on its bundled Node 22.23.3.

The trace pass removes untraced web dependencies after the native swap and
existing build-tool pruning. The untraced custom server's production closure,
including Next, remains whole. No Next configuration or harness packaging changes.
Trace entries are resolved relative to their manifest as described in the
[Next 15 output tracing documentation](https://nextjs.org/docs/15/app/api-reference/config/next-config-js/output).

## Approved automated checks

- `pnpm test:payload`: trace mapping, nested package versions, server closure and
  peers, target-native preservation, client-package removal, missing/malformed
  traces and missing runtime files failing before deletion.
- `pnpm typecheck` and `pnpm build`: required repository checks; builds fresh
  shared, harness, web and server artifacts in this worktree.
- `node --check scripts/build-personal-payload.mjs`,
  `node --check scripts/prune-personal-payload.mjs`, and `git diff --check`.
  No lint command is configured for these scripts.
- `pnpm desktop:payload`: fetch/verify pinned Node, assemble and prune the payload,
  then run its expanded boot proof.
- Rebuild the macOS app with the personal payload and existing harness, using
  an isolated bundle identifier and ad-hoc signing for the smoke run.

## Approved smoke and sabotage checks

- Boot on bundled Node with a fresh temporary database: migrations, `/health`,
  `/login` 200, `/api/office` personal mode, origin-bound challenge and owner
  sign-in. Upload a 128×128 PNG (201), render `/settings/profile` with brand icon
  and avatar (200), serve the icon (200), and retrieve identical avatar bytes
  from `/api/objects/avatars/...` (200). No runtime download or payload write;
  exit when stdin closes. All listeners use loopback and avoid port 3000.
- Run `scripts/personal-office-smoke.mjs` against the rebuilt bundle: all 19
  existing checks, including owner/stranger access, restart, parent exit and
  persistent office identity, under a temporary HOME.
- Remove `@libsql/darwin-arm64` from the pruned payload, rerun `--smoke-only`,
  and retain the failing native-loader log. Restore it and prove success.
- Confirm Phaser and Lucide are absent, remove Phaser if present, and run the
  same boot proof successfully. Keep sabotage confined to generated artifacts.
- Record `payload.json` file/byte counts, removed bytes and largest packages;
  compare with QUIN-57's 408 MiB / 24,703-file payload and 663 MiB app. Record
  rebuilt app size separately; the Node runtime and harness are unchanged.

## Not verified

- Linux, Windows and Intel macOS execution or notarization: host-only smoke;
  platform verification is tracked by QUIN-76. Fixture coverage exercises
  host-to-target native preservation.
- Remote storage, cloud agents, background jobs or migration-failure recovery:
  no changes to those systems; the runtime smoke exercises local storage and
  clean database initialization.
- Full unrelated unit suites and Rust lint/unit suites: no application or Rust
  behavior changed; the new pruning suite and bundled runtime smoke cover this
  change. No browser automation suite exists for this payload builder; HTTP
  checks verify server-rendered output, not canvas gameplay or visual layout.
- Compression, first-run downloading and harness-size optimization: excluded
  from QUIN-74.

## Deployment correction found during verification

The first real trace pass failed before deleting files:

```text
Error: Traced package is missing from payload: sharp@0.34.5
```

The workspace and traces used lockfile-pinned sharp 0.34.5, but pnpm 11's legacy
hoisted deploy installed 0.35.4. Its implementation explicitly disables reading
the lockfile with the hoisted linker. The builder now uses dedicated-lockfile
deployment (`--config.inject-workspace-packages=true`, command-local), keeping
the hoisted layout without changing workspace configuration or the lockfile.
The deployed lockfile and its absolute workspace paths are removed before
shipping. This mode leaves the workspace install state alone, so the old
restore-install workaround is removed. The rebuilt payload passes strict
trace version matching and the expanded boot proof.

## Results

| Automated check | Result |
| --- | --- |
| `pnpm test:payload` | Pass — [8/8 regression tests](./unit-tests.txt) |
| `pnpm typecheck` | Pass — all workspace packages and root scripts |
| `pnpm build` | Pass — shared, harness, web and server; fresh Next traces |
| `node --check` on both payload scripts | Pass |
| `git diff --check` | Pass |
| Pinned Node fetch/checksum and isolated-PATH version proof | Pass — `v22.23.3` |
| `pnpm desktop:payload` | Pass after the deployment correction above — [build and boot log](./payload-smoke.txt) |
| `node scripts/sign-payload.mjs -` | Pass — four Mach-O files signed ad hoc |
| `tauri build --bundles app` with bundle/personal configs | Pass — isolated identifier `sh.quintal.quin74-smoke`, ad-hoc signature |
| `node scripts/personal-office-smoke.mjs` | Pass — [19/19 against the rebuilt app](./bundle-smoke.txt) |

Dependency installation and the initial runtime fetch first hit sandbox DNS
restrictions. Both succeeded with approved network/cache access. No dependency
versions or lockfile entries were changed. Rust compilation reused a copy of the
local release cache; the app was rebuilt in this worktree. The existing harness
sidecar was copied unchanged into the bundle.

### Runtime evidence

The [payload proof](./payload-smoke.txt) booted with a fresh temporary data root:

```text
[payload] /settings/profile 200 with brand icon and avatar; icon 200; /api/avatar 201; avatar object 200 (bytes match)
[payload] ready in 1778ms; /login 200; personal office; challenge bound to http://127.0.0.1:53276; RSS 184MB idle; stopped on stdin EOF
```

The successful owner sign-in, profile read and avatar upload/read exercise clean
migrations, the owner row, session and local object storage. The proof rejects
runtime-download messages and any added, changed or deleted payload files.
It passed both checks. The profile includes the existing brand mark; there are
no Lucide imports in the current web source.

The [bundle smoke](./bundle-smoke.txt) records each of its 19 checks, including:

- Listener `127.0.0.1:53652`, never port 3000; `/api/office` returned
  `{"name":"","personal":true}` and `/login` returned 200.
- Stranger rejected with 403 and the personal-office refusal; owner admitted
  with 200. Guest links refused.
- `quintal.db`, `auth-secret`, `office.json` and `office.lock` in disposable data;
  secret mode 0600.
- Cold start 4,130 ms; second launch exited without disturbing the first;
  killed server restarted on the same port in 1,573 ms, with the same owner.
- Force-quit app took its server down 60 ms later; warm launch in 1,226 ms kept
  the port, office ID and account. No backup on an unchanged version.

### Sabotage

Deleting `node_modules/@libsql/darwin-arm64` caused the boot proof to exit 1
before health answered. The [native-loader log](./missing-native.txt) shows:

```text
Error: Cannot find module '@libsql/darwin-arm64'
Require stack:
- <worktree>/apps/desktop/personal-payload/node_modules/libsql/index.js
Error: the server exited with 1 before answering
```

Removing the entire package fails during native-module resolution, before
`dlopen` is reached; this is the actual failure observed. The native package was
restored in a `finally` block. Phaser and Lucide were already absent after
pruning. Removing Phaser if present and repeating the proof
[passed without either package](./without-phaser.txt), ready in 1,345 ms with
the same profile/icon/avatar checks and stdin-EOF shutdown. The existing payload
was not rebuilt or its manifest rewritten during these proofs.

### Measurements

The checked-in [payload manifest](./payload.json) and
[app measurements](./measurements.json) preserve the exact counts.

| Measurement | QUIN-57 baseline | QUIN-74 |
| --- | --- | --- |
| Payload file bytes | ~408 MiB | 204.45 MiB (214,382,566 bytes), ~50% smaller |
| Payload files | 24,703 | 15,417 |
| App allocated disk space (`du -sm`) | ~663 MiB reported | 433 MiB |
| App sum of file bytes | Not recorded | 391.27 MiB (410,272,305 bytes) |
| Payload health-ready time | ~2.0 s | 1.78 s |
| Idle payload RSS | ~180–190 MiB | 184 MiB |

The manifest's counts are taken before writing `payload.json` and before native
code-signing, matching the builder's existing measurement convention. The app
measurements include its manifest and signatures. File bytes and allocated disk
space are distinct; the old app measurement method was not explicitly recorded,
so the app comparison is approximate.

The trace pass itself removed 9,018 files / 266.88 MiB from this build's deployed
tree using 30 manifests. That is not a direct subtraction from the old 408 MiB
baseline: dedicated-lockfile deployment also corrects the dependency graph used
by the old legacy deploy. Next remains the largest package at 133.3 MiB, followed
by libvips at 15.3 MiB and Drizzle at 9.9 MiB.

## Follow-ups

No new blocking issue was found. Keep cross-platform and notarization verification
under QUIN-76. If a smaller payload is needed, a separate task can trace the custom
server entry with `@vercel/nft` to reduce the remaining whole Next package. That
requires proving the custom server's dynamic runtime paths and is not claimed here.
