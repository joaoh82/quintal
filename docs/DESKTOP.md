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
