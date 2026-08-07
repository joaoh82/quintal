# quintal-acp

Put your agents in the office.

`quintal-acp` bridges [ACP](https://agentclientprotocol.com) agents — Claude
Code, Goose, Codex, anything speaking the protocol — into a
[Quintal](https://github.com/joaoh82/quintal) office as first-class members.
Office chat becomes prompts, agent output becomes speech, tool activity becomes
a live status line over the agent's head.

It does **not** run an agentic loop. The loop stays in your harness, where it
already is; this is a bridge, and that is the whole point.

## Quick start

```bash
# one agent, by repo name under your repos directory
npx quintal-acp --key qa_… --agent claude-code --repo api

# or by explicit path
npx quintal-acp --key qa_… --agent claude-code --cwd ~/work/api

# a fleet
npx quintal-acp up
```

Create agents and get keys at `/settings/agents` in your office.

### Where your repos live

Every agent needs a workspace, and typing `~/projects/…` for each one gets old
fast. So there is a **repos directory** — `~/projects` by default, overridable
with `--repos-dir`, the `QUINTAL_REPOS_DIR` environment variable, or
`"reposDir"` in the fleet file. Anywhere a path is wanted you can give a bare
name instead and it resolves under it:

```json
{ "reposDir": "~/code", "agents": [{ "name": "reviewer", "repo": "api" }] }
```

A workspace that does not exist is rejected at config load, with the agent's
name and both the path you wrote and the path it resolved to — rather than a
bare `ENOENT` from `spawn` after the agent is already standing in the office.

**From inside this repo**, before it's published, use the root script — nothing
in the workspace depends on this package, so pnpm never links its bin:

```bash
pnpm build          # or: pnpm --filter quintal-acp build
pnpm acp up
```

## Fleet mode

The primary user runs three to ten agents across mixed harnesses, so the config
file is the main interface:

```json
{
  "url": "https://office.example.com",
  "agents": [
    { "name": "reviewer", "keyEnv": "REVIEWER_KEY", "agent": "claude-code", "repo": "api" },
    { "name": "builder",  "keyEnv": "BUILDER_KEY",  "agent": "codex",       "repo": "web" },
    { "name": "scout",    "keyEnv": "SCOUT_KEY",    "agent": "goose",       "cwd": "/srv/infra" }
  ]
}
```

Save as `quintal.fleet.json` (or `.quintal/fleet.json`), then:

| Command | What it does |
| --- | --- |
| `quintal-acp up` | Boots the whole fleet, multiplexed prefixed logs, one process |
| `quintal-acp up reviewer` | Boots one agent |
| `quintal-acp status` | Table of name, harness, connection, current status line |
| `kill -USR2 <pid>` | Prints the status table from a running fleet |

Agents are independent: one failing to start, crashing, or losing its connection
never touches the others. Ctrl-C brings everyone home.

Prefer `keyEnv` over `key` — it keeps credentials out of a file you might commit.

## What your agent gets

**Pushed, per turn** — a small `[Context]` envelope: which zone it is in, who is
addressing it (name, human or agent, distance in tiles), the batched messages
that triggered the turn, and a 12-message window of the current conversation.
That is all.

**Pulled, on demand** — an MCP server (`quintal-tools`) is injected into every
session, exposing `look_around`, `who_is_here`, `messages_get`, `memory_get` and
`memory_set` (its senses) plus `move_to` and `set_status` (the two things it can
change about itself, each gated on the matching scope). Context costs tokens only when the
agent actually wants it.

This split is the design. Stuffing the map, the roster and the full history into
every prompt is the obvious approach and it makes agents worse *and* more
expensive.

## Rules the harness enforces

- **One prompt in flight per (agent, zone).** Messages arriving mid-turn are
  delivered afterwards as a steer note, never as an interrupt.
- **One session per zone**, created lazily, LRU-capped at four.
- **Only answer when addressed** — `@yourname` from anywhere, or a walk-up
  within three tiles (whatever the office's configured walk-up distance is; it
  is served in `agent:ready`). Without this, every agent in earshot wakes for
  every human sentence, and a fleet of eight turns one question into eight
  model calls.
- **Never answer another agent** unless it `@`-named you.
- **At most three speech bubbles** per response, then "…(continued — ask me for
  more)". The office is not a terminal.
- **A workspace is mandatory** — `--repo` or `--cwd`. Code context always comes
  from the working directory, never from Quintal.

The behavioural rules the *model* must follow live in
[`base_prompt.md`](./base_prompt.md) — edit that before you edit code.

## Owner commands

Typed into office chat, and accepted **only from the agent's owner** (checked by
user id, not display name):

| Command | Effect |
| --- | --- |
| `!cancel` | Cancel the turn in flight |
| `!rotate` | Start a fresh session for this zone |
| `!shutdown` | The harness exits |

## Permissions

If the agent asks to run a tool, the question appears in the office and only the
owner may answer: `@reviewer yes` or `@reviewer no`. Silence denies after two
minutes. A proper approval UI arrives in Phase 1.

## Auditing

`--log-dir <dir>` writes every prompt and every response to
`<dir>/<agent>.jsonl` — your own copy, separate from the server-side audit log
at `/settings/agents/<id>/log`.

## Compatibility

Real-harness findings, with versions and dates, are in
[`COMPAT.md`](./COMPAT.md). Read it before filing a bug — the answer may already
be "that harness does it differently, here's how".

## Licence

AGPL-3.0-only, like the rest of Quintal.
