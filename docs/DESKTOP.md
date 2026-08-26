# The desktop app

Quintal runs in a browser. The app exists for the two things a web page
fundamentally cannot do: hold your key somewhere durable, and start a process on
your computer.

Everything social — presence, movement, chat, the roster — works the same in
both. The app adds capability; it never adds screens.

## Browser or app?

| | Browser | App |
|---|---|---|
| Presence, movement, chat | ✓ | ✓ |
| Seeing agents, their status and their audit log | ✓ | ✓ |
| Durable key custody (OS keychain) | — | ✓ |
| Encrypted key backup and restore | — | ✓ |
| Detecting which agent CLIs you have | — | ✓ |
| Running your agents | list, assign, enable, disable | ✓ |

The browser is not a degraded client. It is missing exactly the things that
require a computer you control, and it says so where those things would be.

Anything that needs the app is feature-detected through one bridge — never by
sniffing the user agent, which would be a guess about a capability we can simply
ask about.

## Running it

```bash
pnpm desktop
```

Starts the office and the app together. If you already have `pnpm dev` running
in another terminal, use `pnpm desktop:attach` instead.

## The app needs an office to connect to

The app is a client. It loads an office over HTTP — by default
`http://localhost:3000` — and if nothing is answering there it has nothing to
show. It will say so and keep looking, then go straight in the moment the office
appears, so starting the app first is a fine order to do things in.

`pnpm desktop` starts both, which is why it is the command in the README. The
bundled `Quintal.app` starts only itself, so an office has to be running
somewhere it can reach — `pnpm dev` locally, or a deployment.

To point it at one permanently, write the URL to `office` in the app data
directory:

```bash
echo 'https://quintal.example.com' > ~/Library/Application\ Support/sh.quintal.desktop/office
```

The app grants IPC to that one origin and no other, so changing it is a
deliberate act rather than something a page can do to you.

## macOS permissions, and why

### The keychain

Your identity key lives in the login keychain, under one entry
(`quintal-desktop`) holding every secret as a single JSON blob. One entry rather
than several is deliberate: macOS prompts per *entry*, so a key, a machine token
and any future agent credentials in separate entries would be several prompts on
every launch.

**You will be asked for your keychain password once per launch during
development.** That is not a bug in the key handling — it is what an ad-hoc code
signature means:

```
Signature=adhoc, linker-signed
```

An ad-hoc signature's designated requirement *is the code hash*, so every
rebuild is a different program as far as macOS is concerned, and "Always Allow"
grants access to a program that stops existing the moment you change a line.

Signing with a real certificate replaces that requirement with one that does not
move:

```
identifier "sh.quintal.desktop" and anchor apple generic
  and certificate leaf[subject.CN] = "Apple Development: …"
```

Two ways to get it:

```bash
pnpm desktop:bundle
```

Builds a signed `Quintal.app`. This is what to use day to day — it prompts once,
ever. It is signed but **not notarized**, which is fine on the machine that
signed it and not enough to hand to somebody else.

```bash
pnpm desktop:sign
```

Signs the current development binary with the same identity and the same bundle
identifier, so it satisfies the same requirement and shares the one keychain
grant. A rebuild replaces the signature, so re-run it when the prompt comes
back.

Both find your signing identity automatically when you have exactly one;
otherwise set `QUINTAL_SIGNING_IDENTITY`. If you have no certificate at all, the
app still works — macOS just keeps asking.

### If the keychain will not open

The app will tell you it is locked rather than starting over. That distinction
matters more than it looks: "there is no key" and "I cannot read the key" are
the same silence from the outside, and treating the second as the first would
generate a *new* identity over a perfectly good one. A marker file records that
a key exists, so a locked or denied keychain is reported, never worked around.

### Accessibility

Not requested. It will be, when push-to-talk becomes a global hotkey — that
needs to see key presses while Quintal is not focused, and macOS gates it behind
Accessibility. There is nothing to grant until voice ships.

## The menu bar

Quintal keeps a menu-bar item so you can see whether your agents are running
without keeping a window open, and stop them without finding one.

It reports **state, not a count**: running, not running, or *stopped on their
own* — which is worth saying, because agents going quiet otherwise looks the
same as agents you stopped. How many agents are running is a fact the office
holds, not this process; a number here would go stale the moment you enabled or
disabled one, and a number that drifts is worse than none.

**Start agents / Stop agents** does the same thing as the button in Settings →
Agents, using the machine token and repos directory this computer already has.
If it cannot — an unregistered machine, a locked keychain — it opens the window,
because neither is fixable from a menu.

**Quit Quintal** stops the harness on the way out, by the same path as closing
the window.

## Opening at login

Off until you ask for it, in Settings → Agents. The office is where your agents
live all day, so wanting it there when you log in is reasonable — deciding that
for you is not.

It pairs with the app starting your fleet on open: turn both on and your agents
are in the office before you are. Turning it off removes the login item; nothing
else about the app changes.

## What ships inside the app

The app spawns a harness — `quintal-acp` — to run your agents, and the bundle
carries its own copy. It has to: an app launched from Finder has neither a repo
checkout's `node_modules/.bin` nor, on a stock macOS, a PATH containing anything
useful. An app that cannot find the one thing it spawns is not a bundle.

It is compiled to a standalone executable with an embedded runtime, so nothing
has to be installed for it to run, and it lands beside the app's own binary
inside `Quintal.app/Contents/MacOS/`. The host looks there first, then at
`QUINTAL_ACP_BIN`, then at PATH — so a checkout, a bundle and a globally
installed CLI all work, in that order of preference.

Building a bundle therefore needs [bun](https://bun.sh), which does the
compiling. It is a **build** dependency only: running Quintal, developing it and
CI all work without it, and CI never bundles.

### Why the entitlements file exists

The harness embeds a JavaScript runtime, and the hardened runtime that signing
applies forbids allocating executable memory unless asked. Without
`com.apple.security.cs.allow-jit`, the sidecar signs, verifies, and then dies on
its first JIT allocation:

```
Ran out of executable memory while allocating 128 bytes.
```

Nothing in that message says "entitlement", so it is written down in
`entitlements.plist` next to the keys that fix it.

## Where your agents run

The app runs one harness process for this computer, and that harness asks the
office which agents belong here. The office never sends a command line — only a
runtime id, which the host resolves through the same catalogue the settings page
renders. A compromised office can pick from a fixed menu; it cannot write the
menu.

The machine credential is passed to the harness in its environment at spawn:
never on the command line, where any process could read it out of `ps`, and
never in a file, which would outlive the process that needed it.

Agents work under your **repos directory** — `~/projects` unless you choose
another with "Change repos folder". An agent assigned a workspace outside that
directory is skipped rather than started.

## Leaving

Closing the window stops the harness. Quitting from the tray does the same, by
the same path — an orphaned harness would keep agents in the office with nothing
able to see or stop them.
