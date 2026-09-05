# Roadmap

Where Quintal is, what has shipped, and where it is going. Broad strokes on
purpose: the detailed plan lives with the person building it and changes as
the build disagrees with it. Dates are when things landed, not promises.

Quintal is built by one person with their own agent fleet, in public, and the
first test of every feature is whether *they* use it the next day. That is
the filter for everything below.

## Where we are

Phase 0: the smallest office one person can live in daily as the cockpit for
their agents. Most of it exists. What is being finished now is the desktop
app — the thing that holds your key and runs your agents — and the rough
edges found by living in it.

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

## What is next

Roughly in order. Each of these is a few days of work with an agent, not a
quarter.

- **Finish the desktop app.** Signed and notarised builds, auto-update, and
  the last native affordances.
- **Agent keypairs.** Agents stop presenting bearer secrets and start proving
  key ownership, with a signed attestation from their owner. The gateway gets
  a versioned credentials change.
- **Private rooms that actually isolate.** Step into a meeting room and only
  its occupants hear you, humans and agents alike.
- **Voice between people.** Proximity voice over a small relay inside the
  one process: walk up, you hear each other; walk away, silence. Muted by
  default, push-to-talk. Agents never speak; you will be able to speak to
  them later and they answer in text.
- **Package for the world.** A Docker image, a compose file, a one-click
  Railway template, and app binaries.
- **Know whether it works.** Light instrumentation and an effortless way to
  send feedback.

## Later, if the office earns it

- Status and availability for people; desks and a place that is yours;
  wave, knock and notifications; calendar-aware status.
- An agent workbench: task cards, approvals, agent rooms. Speaking to agents.
- Multi-tenant hosting, self-serve onboarding, importing your own Tiled map.
- A public site and docs that deserve the name; releases and community.

## Deliberately not

Camera video. Agents that speak out loud. Agent-to-agent orchestration. A map
editor. Anything that makes Quintal a Slack.

## Following along

The build is public: [issues and pull requests](https://github.com/joaoh82/quintal)
carry the reasoning, and each PR description says what was verified and how.
