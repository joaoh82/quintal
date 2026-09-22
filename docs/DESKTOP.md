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
| Updating itself | — | ✓ |

The browser is not a degraded client. It is missing exactly the things that
require a computer you control, and it says so where those things would be.

Anything that needs the app is feature-detected through one bridge — never by
sniffing the user agent, which would be a guess about a capability we can simply
ask about.

## Installing a release

[Download Quintal](https://quintal.sh/download/) for your operating system.
First [start a server with Docker](../SELF_HOSTING.md#docker), then launch the app
and add `http://localhost:3000` in the server picker. If you changed `QUINTAL_PORT`,
use that port instead. Every installer carries its own compiled harness, so Node
and Bun are not required.

### macOS

Requires macOS 13.0 or later. Choose Apple Silicon or Intel, open the DMG, and
drag Quintal into Applications before launching it.

macOS builds are Developer ID signed and notarized from v0.1.2 on. Gatekeeper
needs no quarantine-removal command for these releases. Earlier releases are
not notarized: for one of those, copy the app to Applications and run
`xattr -dr com.apple.quarantine /Applications/Quintal.app` before opening it.
Each release's notes state which it is.

### Windows

Run the x64 NSIS installer. Windows builds are unsigned, so SmartScreen may show
“Windows protected your PC”. Check `SHA256SUMS.txt` from the release against your
download, then choose **More info → Run anyway** if offered.

### Linux

Choose the x64 AppImage or Debian package. Both need a Secret Service provider
such as GNOME Keyring for key storage; AppImage also requires host `libdbus-1-3`.

```bash
chmod +x Quintal-linux-x64.AppImage
./Quintal-linux-x64.AppImage
```

Or install the Debian package:

```bash
sudo apt install ./Quintal-linux-x64.deb
```

Linux releases are unsigned. Check `SHA256SUMS.txt` against your download.
Maintainers: see [RELEASING.md](../RELEASING.md) for `just release`, signing
secrets, stable download names and retries.

## Updating

The app checks for a new version when the office loads, and asks once if there
is one. Say yes and it downloads the release, replaces itself and restarts. Say
**Later** and it does not ask about that version again — the offer moves to a
quiet **Update to …** button in the office and settings headers, and stays
there until you take it or a newer version arrives.

Every payload is verified against a public key compiled into the app before a
single file is replaced, so an update can only come from a Quintal release that
was signed with the matching private key.

Not every install can replace itself, and the app says so rather than offering
a button that fails:

| Install | Updates itself |
|---|---|
| macOS DMG, copied to Applications | ✓ |
| macOS, still running from the mounted DMG | — copy it to Applications first |
| Windows NSIS | ✓ |
| Linux AppImage | ✓ if the file is somewhere you can write |
| Linux .deb | — apt owns it; update it the way you installed it |

Checking is best-effort and deliberately quiet. Offline, a blocked network or a
release that published no manifest all mean the same thing: no offer, no error,
nothing in the way of signing in.

## Running from source

```bash
pnpm desktop
```

Starts the office and the app together. If you already have `pnpm dev` running
in another terminal, use `pnpm desktop:attach` instead.

## Servers

Two words, and the difference matters. An **office** is the place you are in:
its people, its agents, its channels, its settings — what a guest link admits
you to and what every settings page is about. A **server** is a Quintal
deployment, a URL with an office on it. Today each server has one office per
person, so switching server and switching office are the same act; they will
not always be.

A server is a place, not a setting. Nothing crosses between two of them — the
same shape as a Slack workspace or a Buzz community — so the app keeps a list
and you move between them.

Your **identity is one key**, used everywhere. Each server knows you as its
own user; isolation comes from the server, not from carrying separate keys.

On first launch there is no server, and the app shows a picker rather than
guessing. Add one by URL — `http://localhost:3000` for a local Docker office or while developing, or
wherever yours is deployed. "Add or switch server…" in Settings, and "Switch
server…" in the menu bar, come back to it later.

**A server cannot introduce a new server.** Adding and forgetting are granted
only while *no* server is loaded — that is, while the picker is what you are
looking at. Otherwise a page in your office could add an attacker's URL,
switch to it, and inherit key signing on the next boot.

Switching is different, and allowed: it refuses any URL that is not already on
your list, so the most a page can do with it is send you to another server you
added yourself — somewhere you already trust with the same bridge.
Introducing a new origin is the dangerous half, and that is what stays behind
the picker.

**Switching restarts Quintal**, deliberately. IPC is granted to exactly one
origin at startup, so switching in place would leave the server you left still
able to ask this process for a signature for the rest of the session. Coming
up fresh is how "these two do not talk to each other" stays true rather than
mostly true.

Only the active server's agents run. Switching stops them; the server you
arrive at starts its own.

Forgetting a server also forgets this machine's registration with it — that
token names a machine in an office the app no longer has.

**Each office registers this machine separately.** A host token is minted by
one office and refused by any other, so pointing the app at a second office
— a throwaway local instance, a move from `localhost` to a real server —
does not reuse the first office's credential. On a first connection to an
office this computer is not registered with, the app asks you to name the
machine (the same prompt lives under Settings → Agents). A token this
office rejects is forgotten and the prompt comes back, naming registration
as the fix rather than an auth server that was up and answering. Switching
back to the first office keeps its registration intact.

### Getting out of one

Sign-in can fail for reasons that have nothing to do with your key. The
clearest is a server reached by an address it does not trust:
`http://localhost:3000` and `http://127.0.0.1:3000` are the same server but
different *origins*, and sign-in is deliberately bound to the origin the
server was configured with, so the second is refused with "Sign-in must come
from this site." That check is there to stop a page elsewhere driving a
sign-in, and it is working when it does this.

A server can also simply be gone, or broken.

Either way the app would otherwise boot back into it every launch, so there is
a way out from both places you can get stuck: **Open a different server**
under the sign-in card, and **Choose a different server** while it waits for
one to answer. Both land on the picker, as does **Switch server…** in the menu
bar.

## The app needs a server to connect to

The app is a client. It loads an office from a server over HTTP — by default
`http://localhost:3000` — and if nothing is answering there it has nothing to
show. It will say so and keep looking, then go straight in the moment the server
appears, so starting the app first is a fine order to do things in.

The installed app starts only itself. Run the server with
[Docker Compose](../SELF_HOSTING.md#docker), or connect to an existing deployment.
For source development, `pnpm desktop` starts both the server and app.

Add it in the picker. The app grants IPC to the active server's origin and no
other, so changing it is a deliberate act rather than something a page can do to
you.

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

Builds a local macOS development `Quintal.app`. This is what to use day to day — it prompts once,
ever. It is signed but **not notarized**, which is fine on the machine that
signed it and not enough to hand to somebody else. Use the tag-triggered release
workflow for distributable installers; `pnpm desktop:bundle` remains macOS-only.

```bash
pnpm desktop:sign
```

Signs the current development binary with the same identity and the same bundle
identifier, so it satisfies the same requirement and shares the one keychain
grant. A rebuild replaces the signature, so re-run it when the prompt comes
back.

Both find your signing identity automatically when you have exactly one. With
several, they stop and ask rather than choosing:

```bash
export QUINTAL_SIGNING_IDENTITY="Apple Development: you@example.com (XXXXXXXXXX)"
```

Worth putting in your shell profile, because the choice has to stay stable. A
keychain grant is bound to the signing certificate through the designated
requirement, so signing with a different one is a different program as far as
macOS is concerned — and everything you clicked "Always Allow" for gets asked
again.

If you have no certificate at all, the app still works — macOS just keeps
asking.

### If the keychain will not open

The app will tell you it is locked rather than starting over. That distinction
matters more than it looks: "there is no key" and "I cannot read the key" are
the same silence from the outside, and treating the second as the first would
generate a *new* identity over a perfectly good one. A marker file records that
a key exists, so a locked or denied keychain is reported, never worked around.

### Microphone

Asked for the first time you unmute or hold push-to-talk in the office, and
only then. Two things make the prompt possible, both in the bundle: a usage
description in `Info.plist` (without it macOS does not ask — it terminates the
process the moment the page opens the microphone), and the hardened runtime's
`com.apple.security.device.audio-input` entitlement. The webview's own
capture-permission request is granted by the webview layer, so the system
prompt is the only one. Nothing is recorded, nothing is decoded on the server,
and agents never hear it — see [VOICE.md](./VOICE.md).

### Accessibility

Not needed, and not requested — an earlier version of this page said it would
be. Global push-to-talk is a *registered* hotkey: the system delivers the chord
to Quintal rather than Quintal watching every key, and that needs no grant. The
chord is `⌘⇧Space` (Ctrl+Shift+Space elsewhere), changeable under Settings →
Profile, and works while any other window has the keyboard.

## Inspecting it

Devtools are enabled in release builds as well as development ones — right-click
→ Inspect Element, or ⌥⌘I. Tauri ships the inspector in debug builds only unless
asked, which meant the bundled app, the one actually used day to day, was the
one that could not be inspected. That is backwards: the awkward bugs live
exactly there — a blank window with no office, a runtime list empty because a
Finder launch inherits no PATH — and reproducing them in a dev build, where the
conditions differ, is how you end up fixing the wrong thing.

Worth revisiting before there are users who are not us: it hands an inspector,
and a window onto a privileged bridge, to whoever holds the app.

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
inside `Quintal.app/Contents/MacOS/`. The host checks `QUINTAL_ACP_BIN` first —
an explicit override should win over anything found — then beside the
executable, then PATH. So a bundle, a checkout and a globally installed CLI all
work.

Building a bundle therefore needs [bun](https://bun.sh), which does the
compiling. It is a **build** dependency only: running Quintal, developing it and
ordinary CI checks work without it. Release CI installs Bun to compile each
platform's sidecar. On Windows the bundled executable is `quintal-acp.exe`.

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

Agents work in the **nest**, `~/.quintal`: one workspace shared by every agent
on this machine, with guides, research and plans, and your repositories
reachable under `REPOS/`. That link points at your **repos directory** —
`~/projects` unless you choose another with "Change repos folder". The harness
makes the nest and keeps its `AGENTS.md` current when the fleet starts.

## Leaving

Closing the window stops the harness, and quitting from the tray does the same
by the same path.

That covers a tidy exit and nothing else. An app that crashes, is force-quit or
is killed runs no handler at all, and what survives is not an idle process — it
is a whole fleet still in the office, agents nothing on the machine can see or
stop. They accumulate: one more duplicate set of every agent per launch.

So the harness also watches from its end. A fleet started by the app exits when
that app is no longer its parent, which covers every way the app can die
including the ones no handler runs for. A harness you start yourself in a
terminal is unaffected — it keeps running when the shell exits, because that is
a reasonable thing to want.
