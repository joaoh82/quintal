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

## What works so far

Identity: create on first run, sign in, import. Runtime detection, fleet
spawning, NIP-49 backup and the native affordances land in later slices; the
bridge deliberately does not declare them yet, because a method the host does
not answer is worse than an absent one.
