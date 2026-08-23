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
| `QUINTAL_SECRETS_BACKEND` | `file` to skip the OS keychain — for CI and for a dev box you would rather not prompt. |
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

If no keychain is reachable at all, secrets fall back to a `0600` file in the
app data directory, written atomically.

## Only your office may call the bridge

IPC is granted to exactly one origin, built at startup from the configured
office URL. The tempting shortcut — a `https://*` pattern — would mean any page
the window ever reaches can ask this process to sign a challenge. Changing
offices means restarting, which is the right price.

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
