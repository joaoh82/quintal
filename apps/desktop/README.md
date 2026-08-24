# The Quintal desktop host

A window onto your office that can do the things a browser cannot: hold your
key in the OS keychain, and — in later slices — spawn your fleet and take a
global push-to-talk hotkey.

**This is not a second client.** The window loads `apps/web`, the same UI a
browser loads. Everything native is offered to that UI through one narrow
bridge (`apps/web/src/lib/host.ts`), and a screen that exists only in the app
is a bug rather than a feature.

## Running it

Needs a Rust toolchain. Nothing else in the repo does — `pnpm build`,
`pnpm start` and `pnpm test` never touch Rust, so self-hosting Quintal still
needs no compiler.

```bash
pnpm dev                 # the office, on :3000
pnpm desktop             # the app, in another terminal
```

| Variable | What it does |
| --- | --- |
| `QUINTAL_OFFICE_URL` | Which office to open. Default `http://localhost:3000`. |
| `QUINTAL_SECRETS_BACKEND` | `file` to skip the OS keychain — for CI and for a dev box you would rather not prompt. Detected automatically otherwise. |
| `QUINTAL_PRIVATE_KEY` | Sign with this key (hex or `nsec`) instead of the stored one. Used in memory, never written down. |

## Where your key lives

One keychain entry (`quintal-desktop` / `secrets`) holding a JSON map: the
identity plus any agent credentials. One entry rather than one per secret
because macOS prompts *per entry*, and a fleet of ten agents would otherwise
mean ten dialogs at launch — which teaches people to click through without
reading.

Beside it sits `identity.marker`, holding the **public** half. That file is what
lets the app tell "no key yet" apart from "there is a key and the keychain will
not open". Confusing those two would mean generating a fresh identity over a
real one, which cannot be undone, so a locked keychain is a state the UI
explains rather than a case it silently recovers from.

If this machine has no credential store at all — a Linux box with no secret
service — secrets fall back to a `0600` file in the app data directory, written
atomically. That is decided by whether a keychain can be *addressed*, never by
whether a read succeeds: a failed read means the keychain is **locked**, and
falling back there would look like a first run and mint a new identity over a
perfectly good one.

## Only your office may call the bridge

Each command is declared in `build.rs` and granted, by name, to exactly one
origin built at startup from the configured office URL. Both halves matter:
without the app manifest, Tauri takes its "all application commands are
allowed" branch, and since the office is a *remote* origin the runtime then
refuses every call — the app looks alive and nothing works. With it, the grant
is explicit and narrow.

The office URL is validated before it is interpolated into that grant. A value
like `https://*` would become the pattern `https://*/*`, which is every site on
the internet, so globs, `file:` and hostless URLs all fall back to localhost.

**Cleartext `http` is allowed only to this machine.** `export_backup` returns
the encrypted blob *and* its passphrase, which together are the key — so an
office reached over plain http is one anybody on the path can lift an identity
from. Loopback has no path to sit on; everywhere else needs `https`.

Changing offices means restarting, which is the right price.

## Verifying the bridge

```bash
node scripts/desktop-ipc-check.mjs
```

Stands up a throwaway office, points the app at it, and drives **every** command
across the real IPC hop — including the two that must be *refused*: a backup
confirmation with a token nobody issued, and a wipe after the identity has been
replaced. Then it checks the signature that came back with `@noble/curves`, the
library the real office verifies against.

This exists because a slice shipped with every command rejected and nothing
caught it: the Rust tests call the functions directly, the web tests mock the
bridge, and neither crosses the hop where the ACL applies. It runs in CI, under
`xvfb`, for the same reason — a guard nobody runs is not a guard.

## Backing up your key

Settings → Profile, inside the app. Export produces a NIP-49 `ncryptsec1…` —
your key encrypted under a passphrase — and a passphrase generated from the EFF
short wordlist. Both are shown once, and the blob is decrypted and checked
against the live key before you are given it, because a backup nobody can open
is worse than none: it is one you believe you have.

**Six words, not three.** The list holds 1296 words, so each is 10.34 bits.
Three words is 31 bits, and a backup is a thing people write down and mislay;
scrypt makes each guess cost 64 MiB, but 2³¹ candidates is within reach of
anyone willing to spend a little, and the prize is an identity that cannot be
revoked or reissued. Six words is 62 bits, which is not. The cost is two more
words on the paper — see `PASSPHRASE_WORDS` in `src/nip49.rs`.

Wiping is refused until you have exported *and* confirmed you stored it. A blob
rendered on screen and never written down is not a backup, and this is the one
button here that cannot be taken back.

## What works so far

Identity: create on first run, sign in, import, back up, restore, wipe. Runtime
detection, fleet spawning and the native affordances land in later slices; the
bridge deliberately does not declare them yet, because a method the host does
not answer is worse than an absent one.
