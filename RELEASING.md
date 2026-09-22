# Releasing Quintal

From a clean, up-to-date `main` checkout, with Node, Rust/Cargo and `just` installed:

```sh
just release 0.1.0
```

This is the maintainer operation that intentionally versions `main`; implement
release tooling changes on a feature branch. The command refuses another branch,
a dirty tree (including untracked files), a local `main` different from
`origin/main`, a malformed SemVer, or an existing tag. It updates the root,
`apps/*` and `packages/*` package manifests, Tauri config and Cargo manifest, then
runs `cargo update -w` to update the Cargo lock. Cargo failure restores the files.
It creates a DCO-signed-off `release: v0.1.0` commit and annotated `v0.1.0` tag,
then pushes both atomically. Git credentials must permit updating `main` and tags.
Versions must differ from the current version to produce a release commit.
The same `v*` tag publishes the office image via `.github/workflows/docker.yml`
(`:{version}`, `:{major}.{minor}`, `:latest` for stable tags), so the image
and the app agree.

`node scripts/set-version.mjs 0.1.0` performs only the manifest update, useful on
a feature branch for a prerelease rehearsal. All packages share one version,
including the server version reported by `/health`. The `v` prefix belongs to
tags only. Review any dependency changes caused by Cargo before retrying a
failed release operation.

If the atomic push fails, neither remote ref was updated. The local release
commit and tag remain: resolve the permission/network problem and retry
`git push --atomic origin main refs/tags/v0.1.0`. If somebody advanced `main`,
reconcile locally before pushing; never force-push or move a published tag.
Branch protection may require an owner-approved release route before this command
can push; it does not bypass repository rules.

## What the tag builds

`.github/workflows/docker.yml` publishes `ghcr.io/joaoh82/quintal` for the same
tag (`:0.1.0`, `:0.1`, `:latest` for a stable release; `:main` and `:sha-<7>`
on every push to main). `.github/workflows/release.yml` validates the exact tag's checked-in version
against every package manifest, Tauri config, Cargo manifest and Cargo lock.
A mismatch fails setup before any platform jobs run. Builds all check out the
same resolved commit.

Release Actions are pinned to commit SHAs, with their upstream tag noted beside
each pin. Update those pins deliberately when upgrading build tooling.

| Platform | Runner / target | Installer |
| --- | --- | --- |
| macOS Apple Silicon | `macos-latest`, `aarch64-apple-darwin` | DMG |
| macOS Intel | `macos-latest`, `x86_64-apple-darwin` | DMG |
| Linux x64 | Ubuntu 22.04, `x86_64-unknown-linux-gnu` | AppImage and .deb |
| Windows x64 | `windows-latest`, `x86_64-pc-windows-msvc` | NSIS .exe |

Each build compiles its own standalone `quintal-acp` with Bun. Intel macOS uses
an explicit Bun target and Rosetta to run its `--help` proof on Apple Silicon.
All Intel/x64 builds use Bun's baseline target, including under Rosetta. The app needs no installed
Node or Bun. macOS requires 13.0 or later because of the embedded Bun runtime.

Compiling for a target Bun is not itself running makes it fetch that runtime and
unpack it, and on Windows the unpacking fails outright. So the Windows job
installs the baseline build *as* its Bun, through `bun-download-url`, and asks it
for the target it is already running. Keep that URL's version in step with
`bun-version` on the other platforms.

The build applies `tauri.bundle.conf.json` for the sidecar and
`tauri.release.conf.json` for release settings, on top of the base Tauri config.
Keep the latter a delta: never duplicate `bundle.externalBin` there, because
JSON merge-patch replaces arrays. The AppImage is the exception: it is bundled
*without* `tauri.bundle.conf.json`, so linuxdeploy never sees the harness. Given
one, it runs `ldd` over it, and the non-zero exit reaches linuxdeploy as an
uncaught exception that aborts the whole bundle. `fix-appimage.sh` installs the
harness during its repack instead, and the first-launch smoke proves it is there.
The AppImage is built before the deb so the deb left behind is always the one
carrying its sidecar the ordinary way. Keep `entitlements.plist`: native Tauri signing
must apply its JIT entitlements to the Bun sidecar. Each macOS job mounts the
finished DMG, verifies its app signature and sidecar JIT entitlement, runs the
packaged sidecar, and checks the stapled ticket when notarization is enabled.

All builds upload private staging artifacts. Only after all four succeed does
the publish job create a draft, upload every original installer plus stable
copies and `SHA256SUMS.txt`, then un-draft as its final step. Notes contain the
Git log since the previous reachable version tag and signing/platform details.
Prereleases are marked as such and do not replace the latest stable download.
A retry can replace assets in an existing draft; it refuses to modify a public
release. A stable release that is becoming the latest also publishes
`latest.json`, the update manifest installed copies read — see **Self-update**.

## Self-update

Installed copies check `releases/latest/download/latest.json` and update
themselves from it. Two repository secrets sign the payloads:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key from `tauri signer generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password protecting that key |

The matching public key lives in `tauri.conf.json` under `plugins.updater` and
is compiled into every build. **Back the private key up.** It is the only thing
that can produce an update an installed copy will accept; losing it means no
future release can ever update anyone, permanently, and the only way back is
asking every user to download an installer by hand.

`tauri.release.conf.json` sets `createUpdaterArtifacts`, so each platform
bundles a payload and a `.sig` beside its installer. Both are declared in
`scripts/release-assets.json` and go out under stable names like every other
asset. They are **optional**: a build with no signing key still publishes every
installer, and the release simply carries no manifest rather than failing.

`publish-release.mjs` writes `latest.json` only when every platform's payload
and signature is present *and* the release is a stable one that is becoming the
latest. A prerelease never writes one — a rehearsal tag would otherwise hand a
release candidate to every installed copy that asks — and neither does a re-run
of an older tag. URLs inside it are pinned to that tag, never to `latest`, so a
published signature always describes the file it points at.

Two platforms cannot replace themselves, and the app offers a download and an
explanation instead: a `.deb`, which apt owns, and any copy running from a
directory it cannot write, such as a macOS app still inside its mounted DMG.

The AppImage needs care. `fix-appimage.sh` repacks it *after* Tauri bundles it,
so whatever Tauri wrapped and signed is a binary nobody ships — an update built
from it would hand Linux users back the AppImage without its harness, correctly
signed, which is worse than failing. The release therefore rebuilds and
re-signs that payload from the repacked image, and checks the tarball holds
exactly one member named for it. Keep those steps together if either changes.

When verifying a release, add to the manual pass: install the previous version
on a clean machine, publish this one, launch the old copy, accept the update,
and confirm it comes back on the new version with its signature intact.

## Signing

Configure these repository Actions secrets to enable Tauri's native macOS
Developer ID signing and notarization:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded .p12 containing the Developer ID Application certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that .p12 |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: …` identity |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Apple developer team ID |

See [Tauri's signing documentation](https://v2.tauri.app/distribute/sign/macos/).
An Apple Development certificate is for local development, not this release.
If any required secret is absent, the job clears partial credentials and produces
an **unsigned, unnotarized DMG**. It signs ad hoc to retain runtime entitlements;
that is not a verified publisher signature. Both the job summary and release
notes state this. A configured signing/notarization failure fails the build,
rather than silently falling back. Windows and Linux are unsigned for now.

The owner can enrol in the Apple Developer Program before the first tag, or
ship the first version unsigned. To open an unsigned download after copying the
app to Applications:

```sh
xattr -dr com.apple.quarantine /Applications/Quintal.app
```

The Linux AppImage requires **host libdbus** (`libdbus-1-3` on Debian/Ubuntu);
the release removes its bundled copy and repacks with a checksum-pinned
appimagetool, preserving the original AppImage runtime and installing the
harness into `usr/bin`. The keyring backend also needs a Secret Service
provider, such as GNOME Keyring. A .deb installation resolves its declared system
dependencies through apt. Linux portability beyond the release runner still
needs testing on the distributions you intend to support.

## Stable download contract

`scripts/release-assets.json` is shared by the workflow and the website. Stable
URLs have this prefix:

`https://github.com/joaoh82/quintal/releases/latest/download/`

| Asset name |
| --- |
| `Quintal-macos-arm64.dmg` |
| `Quintal-macos-x64.dmg` |
| `Quintal-linux-x64.AppImage` |
| `Quintal-linux-x64.deb` |
| `Quintal-windows-x64-setup.exe` |
| `SHA256SUMS.txt` |

Checksums cover both original filenames and stable copies. For example, download
the checksum file and selected installer, then use `sha256sum --ignore-missing -c
SHA256SUMS.txt` on Linux, or compare `shasum -a 256 <installer>` on macOS. These
URLs begin resolving once the first stable release has been published.

## Retry and rehearsal

For a failed platform, use **Actions → Release → Re-run failed jobs**; successful
platform artifacts remain available for 14 days. To rebuild all four platforms,
use **Run workflow**, supplying the existing `v…` tag, or:

```sh
gh workflow run release.yml --ref main -f tag=v0.1.0
```

Dispatch resolves `refs/tags/<tag>` explicitly and checks the versions again; a
branch name is refused. It builds the tag commit, not the selected dispatch
branch's application code. Workflow dispatch requires the workflow to exist on
the default branch. Never delete and recreate a release tag to retry.

Before a first stable release, rehearse on a branch with all manifests set to
`0.0.1-rc.1`, commit with `-s`, tag `v0.0.1-rc.1`, push the tag, and dispatch that
tag. A successful rehearsal publishes a **prerelease**. For the negative case,
in a disposable test repository tag a commit whose manifests say `0.0.1` as
`v0.1.0`: setup must fail and all platform jobs must be skipped. Do not consume
a planned production version tag for a sabotage test.

## Verification before calling a release ready

- `pnpm test:release` exercises manifest versioning, malformed input, Cargo
  rollback, tag mismatch, release guards, an atomic push to a temporary local
  bare repository, complete asset collection and checksum integrity. It also
  covers the update manifest: every platform present, signatures carried
  through, an empty signature refused, a prerelease never publishing one, and
  an unsigned build still shipping its installers.
- The ordinary CI job runs those tests through `pnpm test`. Desktop CI retains
  Rust format, Clippy, unit tests and its existing IPC checks. The Windows release
  job additionally tests lookup of the packaged `quintal-acp.exe`.
- The Linux release job launches the actual AppImage under Xvfb with fresh app
  data. It requires OCR of **Which server?**, checks the packaged sidecar's
  `--help`, and refuses an AppImage containing libdbus. The `appimage-smoke`
  artifact contains the screenshot, OCR text and process logs, including failures.
- On clean macOS Apple Silicon and Intel machines, install the DMG and confirm
  the server picker opens. On a clean Windows VM, install the NSIS executable
  and do the same. Also install the .deb on a clean Ubuntu VM. Attach screenshots
  and OS details to the release PR. A successful build alone does not prove
  installation or Gatekeeper/SmartScreen behavior.

The automated AppImage smoke uses a file secrets backend to avoid a CI keychain
prompt; it does not verify a user's desktop Secret Service. Credential-backed
notarization, real downloaded-file quarantine behavior, all clean-VM installs,
and website stable links need their respective environments. Keep any missing
verification explicit in the PR.

## Public download links

The website’s [/download](https://quintal.sh/download/) page imports
`scripts/release-assets.json` and links to stable filenames under
`releases/latest/download/`. When changing that contract, update the page’s
explicit installer selections too. CI runs `node scripts/check-release-links.mjs`
to catch unknown links in the website, README and docs, and installers missing
from the download page.

After publishing the first release, and whenever download routing changes, run
**Check published downloads** from GitHub Actions (`check-downloads.yml`). It
follows every installer URL with `curl -fsSLI`, requires a 302 redirect and a
final 200 response, and prints the response headers as evidence. It checks the
current latest release without downloading or executing installers.
