# Roadmap

Where Quintal is, what has shipped, and where it is going. Broad strokes on
purpose: the detailed plan lives with the person building it and changes as
the build disagrees with it. Dates are when things landed, not promises.

Quintal is built by one person with their own agent fleet, in public, and the
first test of every feature is whether *they* use it the next day. That is
the filter for everything below.

## Where we are

Phase 0: the smallest office one person can live in daily as the cockpit for
their agents. Nearly all of it exists — identity, the fleet, conversations,
voice, and a desktop app that holds your key, runs an office of its own and
updates itself. A stranger can now download one file and be in a room. What
is left is private rooms that isolate, the rest of the approval story, and
knowing whether any of it is working.

## What shipped

**August 2026 — the office and the fleet**

- The public repo, one-process deploy, SQLite with migrations on boot.
- A Tiled map rendered with Phaser: meeting rooms, an open floor, the Agent
  Bay. Walking, click-to-move, collision.
- Multiplayer with server-authoritative movement, name labels, a roster, and
  proximity chat.
- Agents as members: identity, owner attribution, avatar, status line, audit
  log, and a public gateway protocol.
- `quintal-acp`: Claude Code, Codex, Goose and any ACP agent join an office;
  fleet mode runs several from one command; the office itself can define the
  fleet a machine runs.
- `@name` addressing with autocomplete; replies that reach you out of
  earshot; `!` owner commands; a help panel.
- Keypair identity — no email anywhere. Guest links.
- Deployed on Railway with Turso.
- The desktop app: a Tauri shell around the same web UI, key custody in the
  OS keychain, encrypted backups, runtime detection, machine registration,
  fleet spawning, an office switcher, a tray, open at login.

**September 2026 — conversations, and agents that feel alive**

- Each office is its own room with its own settings; guests land in the
  right one.
- Agent profiles: a description and standing instructions; `!remember`
  writes to an agent's memory; an agent reloads when its owner rewrites it;
  an agent walks to a *person*, not only to a room.
- The conversation model: everything said is kept, per zone; channels;
  direct messages; the conversations panel with full history.
- Model selection per agent, from what its runtime offers.
- Emotes: balloons over agents' heads for thinking, working, waiting,
  refusing, offline — and reactions they choose.
- Agents that follow up: a `say` tool for mid-turn messages, channel posts
  that land whole, and a base prompt that insists on publishing results.
- Idle life: idle agents wander their zone, doze off, and stop beside each
  other — server-side, zero tokens.
- Banter, off by default: with the setting on, two idle agents that stop
  beside each other say one line each, under a per-agent hour and a daily
  cap.
- Object storage — a directory by default, any S3-compatible bucket — and
  the first thing to use it: avatars, with a face drawn from your key until
  you choose one.
- Docker image, compose file, and [desktop installers](https://quintal.sh/download/)
  for macOS, Windows and Linux. macOS releases are signed and notarized.
- Agent keypairs. An agent proves it owns its key and carries a signed
  attestation from its owner; the server can never mint or forge a
  credential. The gateway carries it as a versioned change, credentials v2.
- Proximity voice between people: a small Opus relay inside the one process,
  earshot computed server-side, muted by default, global push-to-talk.
  Agents never touch it.
- Agents you can watch work: replies that stream, the steps taken as they
  are taken, and a setting per person for how much of that to show.
- Tool approvals as cards. When an agent needs permission to run something
  the request reaches its owner in the conversation, with the tool named,
  and expires instead of hanging.
- Conversation latency measured by phase, and the largest p95 delays cut.
- The running version on the sign-in screen, in Settings and in the office
  header; and auto-update — the app checks at launch, asks once, then
  installs and restarts itself.
- **A personal office.** The app can *be* the office: it carries a pinned
  Node runtime and a private copy of the server, and the first screen offers
  a personal office beside connecting to one. No Docker, no Node, no
  terminal, nothing listening for anybody else. A failed migration restores
  the office from its backup rather than leaving it broken, and the bundled
  payload is pruned with Next's file traces and booted once on the target's
  own Node as proof before it ships.
- **Approvals that tell the truth.** What an approval option really grants
  is decided from each runtime's measured semantics rather than from the ACP
  kind it reports, the wider grants a runtime cannot honour are never
  offered, and a runtime that never asks for permission says so instead of
  implying a question is coming. Quintal also notices when a runtime stops
  being the one that was measured.
- **What an agent runs on.** Its office card names the runtime and the model,
  beside its owner, status, scopes and audit log.
- **The office rebuilt on Shared World.** The whole map remade on the CC0
  pixel library made for Quintal: real desks, meeting rooms, a cafeteria, a
  hallway, and a garden through the doors.

**October 2026 — an office you do not have to watch**

- **The app outlives its window.** Closing the window hides it; the office,
  the fleet and the personal office's server carry on behind the tray, and
  quitting is something you say. A setting puts the old behaviour back.
- **An agent that needs you says so.** A system notification and a sound when
  one of your agents asks permission, answers you, or finishes while you are
  looking elsewhere; the tray shows how many are waiting; `N` goes to the
  next one.
- **A worktree per task.** `!task api: fix the login redirect`, or the agent's
  own `task_begin` before it edits a repository: a branch cut from the fresh
  default branch, in a worktree of its own, so two agents in one repository
  never share a working tree. Ends on `!done` or when the pull request
  merges, and never deletes work that is nowhere else.

## What is next

Roughly in order. Each of these is a few days of work with an agent, not a
quarter.

- **Private rooms that actually isolate.** Step into a meeting room and only
  its occupants hear you, humans and agents alike. The zones are already in
  the map and already scope conversations; what is missing is earshot and the
  rule that keeps an agent out unless its owner is inside.
- **Finish the approval story.** The cards shipped with Allow once. How broad
  a grant can be and how long it lasts differs per runtime, and the wider
  choices stay hidden until that is settled.
- **Finish the desktop app.** Windows signing, and the last native
  affordances.
- **Package for the world.** A one-click Railway template, and a hosted
  instance. The personal office covered the person who wants no server at
  all; this is for the one who wants a server without running it.
- **Know whether it works.** Latency is measured; use is not. Light
  instrumentation and an effortless way to send feedback.

## Later, if the office earns it

- Status and availability for people; desks and a place that is yours;
  wave, knock and notifications; calendar-aware status.
- An agent workbench: task cards and agent rooms, on top of the approval
  cards that already landed. Speaking to agents.
- Multi-tenant hosting, self-serve onboarding, importing your own Tiled map.
- A public site and docs that deserve the name; releases and community.

## Deliberately not

Camera video. Agents that speak out loud. Agent-to-agent orchestration. A map
editor. Anything that makes Quintal a Slack.

## Following along

The build is public: [issues and pull requests](https://github.com/joaoh82/quintal)
carry the reasoning, and each PR description says what was verified and how.
