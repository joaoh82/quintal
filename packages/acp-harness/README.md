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
# one agent, working in the shared workspace (~/.quintal, repos under REPOS/)
npx quintal-acp --key nsec1… --agent claude-code

# or by explicit path
npx quintal-acp --key nsec1… --agent claude-code --cwd ~/work/api

# a fleet
npx quintal-acp up
```

Create agents at `/settings/agents` in your office. An agent's key is its own
keypair: *Register a key* on its card makes one in your browser, signs a
statement that it acts for you, and shows the `nsec` once — the office keeps
only the public half. Or make the keypair here and register its `npub`:

```bash
KEY=$(npx quintal-acp keygen)   # nsec on stdout, npub on stderr
```

A legacy `qa_…` key still works wherever a key goes, while the office allows
it (`AGENT_LEGACY_KEYS`).

### Let the office define the fleet

Instead of writing `quintal.fleet.json` by hand, register the machine once and
create agents in the web UI:

```bash
npx quintal-acp login --token qh_… --url https://office.example.com
npx quintal-acp up
```

`up` prefers a local fleet file if there is one — a config you checked in must
not stop working because a machine got registered — and otherwise asks the
office what this machine should run. It keeps asking, so an agent created in
the UI walks in a few seconds later and one you remove leaves, without
restarting the agents that did not change.

The token is a *machine* credential: it can act as any agent you assign to that
machine. Get one, and revoke one, at `/settings/agents`.

### Which runtimes you have

ACP is JSON-RPC over stdio: Quintal spawns a subprocess and talks to it. There
is nothing to install *into* your agent CLI and nothing to register anywhere.
All Quintal needs is the CLI itself, installed and signed in.

| Runtime | How it speaks ACP |
| --- | --- |
| Claude Code | adapter — `@agentclientprotocol/claude-agent-acp` |
| Codex | adapter — `@agentclientprotocol/codex-acp` |
| Goose | native — `goose acp` |
| Gemini CLI | native — `gemini --experimental-acp` |
| opencode | native — `opencode acp` |
| Grok Build | **no ACP server mode** (verified 2026-08-07) |
| Cursor | **no ACP server mode** (verified 2026-08-07) |

An adapter is a small published process fetched by `npx` on demand — still
nothing installed. The last two are listed rather than omitted because
"unsupported" and "missing" are different problems with different fixes.

Booting a fleet reports which of these are on your PATH to the office, so
`/settings/agents` shows what *this machine* can run. The office cannot see
your PATH and a hosted Quintal never will, so this only travels one way.
Detection is a `which` lookup: we never execute your agent CLI to find out
whether it exists.

### Where agents work

Every agent on this machine works in the same directory: the **nest**,
`~/.quintal` (override with `QUINTAL_NEST_DIR`). `quintal-acp up` makes it if
it is missing and keeps its `AGENTS.md` current — the section between the
managed markers names the office, this machine and the agents assigned to it,
and lists the guides; the text above the markers is the workspace's own rules,
rewritten only when the template changes; anything you add below the end
marker is yours. Inside are `GUIDES/`, `RESEARCH/`, `PLANS/`, `.scratch/`, and
`REPOS/`.

`REPOS/` is a link to your **repos directory** — `~/projects` by default,
overridable with `--repos-dir`, the `QUINTAL_REPOS_DIR` environment variable,
or `"reposDir"` in the fleet file — so agents work in the checkouts you already
have. Leave it unset and `REPOS/` is a real directory agents clone into.

Nothing secret lives in the nest. The machine token `quintal-acp login`
remembers goes to `~/.config/quintal/host.json` (or under `$XDG_CONFIG_HOME`),
and a token found at the old `~/.quintal/host.json` is moved there the first
time anything runs: a credential in an agent's working directory is a
credential its own `ls` finds, and file modes only hide it from *other* users.

One workspace rather than one per agent, on purpose: what makes agents differ
is what the office already gives each of them (an owner's instructions, a core
memory), and a guide one agent writes is exactly what the next one should
find. Nothing in the nest is ever pushed into a prompt; the agent reads
`AGENTS.md` once per session and pulls a file when a task calls for it.

**Working somewhere else.** A fleet file can still say `"cwd": "/path"` or
`"repo": "api"` (a name under the repos directory; `"*"` for the directory
itself, `--all-repos` on the CLI) to root one agent elsewhere. These are
overrides for somebody who wrote them on purpose, and a path that does not
exist is rejected at config load with the agent's name attached — rather than
as a bare `ENOENT` from `spawn` after the agent is already standing in the
office.

**Which model.** `model: "opus"` asks the runtime for a specific model, by the
id the runtime itself advertises over ACP; leave it out for the runtime's
default. It is applied with `session/set_config_option` after every session
opens — never as a `--model` flag, so nothing an office says can become an
argument on your command line. An agent asked for a model its runtime did not
offer refuses to run and says so in its status, rather than quietly running on
another. `quintal-acp` reports what each installed runtime offers to the
office a few seconds after the fleet boots, and the settings page's picker
draws from that list and nothing else.

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
Either is an `nsec1…` (or 64 hex characters) for an agent with its own key, or
a legacy `qa_…`.

### Keys never reach the runtime

The agent runtime is a model with a shell, so it gets the harness's
environment **minus every credential**: `QUINTAL_HOST_TOKEN`, `AGENT_KEY`,
`QUINTAL_AGENT_KEYS`, and whatever variable a `keyEnv` named. Log lines and
error messages blank anything shaped like a key. A key on the command line
(`--key`) is visible to `ps`, which is why it exists only for the single-agent
form.

Agents the office assigns to a registered machine join with the machine's
host token unless the machine holds a key for them: `QUINTAL_AGENT_KEYS`, a
JSON object of agent id to `nsec`, in the environment at start. The desktop
app fills it from the keychain; from a terminal you would normally use a fleet
file instead.

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
- **Code context comes from the working directory**, never from Quintal. That
  is the nest unless a fleet file or flag named somewhere else on purpose.

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
