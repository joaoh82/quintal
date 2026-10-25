# Harness compatibility

ACP is young and its implementations differ. This file records what was
actually observed, on real harnesses, with dates and versions — not what the
spec says should happen.

**Last verified: 2026-10-25**, against `@agentclientprotocol/sdk@1.3.0`,
protocol version `1`.

| Harness | Package | Version | `initialize` | `session/new` | Our MCP server | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` | 0.65.0 | ✅ | ✅ | ✅ accepted | **yes** |
| Claude Code (old) | `@zed-industries/claude-code-acp` | 0.16.2 | ✅ | ⚠️ see below | ✅ accepted | **yes** |
| Codex | `@agentclientprotocol/codex-acp` | 1.1.13 | ✅ | ✅ | ✅ accepted | **yes** |
| Goose | `goose acp` | — | — | — | — | **no — not installed** |
| Cursor | `cursor-agent acp` | 2026.10.16 / .19 | ✅ | ✅ | ✅ accepted | **yes** |
| Scripted fake | `test/fixtures/fake-acp-agent.mjs` | — | ✅ | ✅ | ✅ | yes (CI) |

Every row marked verified was exercised by spawning the real binary and
completing a handshake plus a session creation carrying `quintal-tools`.
Prompt turns were not driven against the paid harnesses — that spends the
owner's tokens, and the fake covers the turn machinery.

---

## Findings

### 1. `@zed-industries/claude-code-acp` is deprecated — use the renamed package

The package prints on startup:

> This package has been renamed to `@agentclientprotocol/claude-agent-acp`.
> Please migrate to continue receiving updates.

The default command for `agent: "claude-code"` is the **new** package. The old
one still works, but see the next finding.

### 2. The old Claude Code adapter refuses to run inside a Claude Code session

Booting a fleet from a terminal that is itself a Claude Code session fails with:

```
Error: Claude Code cannot be launched inside another Claude Code session.
Nested sessions share runtime resources and will crash all active sessions.
To bypass this check, unset the CLAUDECODE environment variable.
```

`initialize` succeeds and then `session/new` fails with a JSON-RPC internal
error (`-32603`, *"Query closed before response received"*) — the useful message
is only on stderr, which is why the harness surfaces agent stderr as warnings
and adds an explicit hint when it sees this one.

**`@agentclientprotocol/claude-agent-acp@0.65.0` does not have this check** and
starts fine in the same situation. That is the main reason it is the default.

Deliberately *not* worked around by unsetting `CLAUDECODE` for the child: the
check exists because two Claude Code runtimes really do share resources, and
silently disabling somebody's crash guard is not our call to make.

### 3. `session/new` responses vary in shape, and that's fine

Three different sets of extra fields came back from three harnesses:

- `claude-agent-acp` → `modes: { currentModeId: "auto", availableModes: [...] }`
- `claude-code-acp` (old) → `models: { availableModels: [...] }`
- `codex-acp` → `models: { availableModels: ["gpt-5.6-sol[low]", ...] }`

Only `sessionId` is required by the schema, and it is the only field the harness
reads. Anything that starts branching on modes or models will break on the next
harness.

### 4. stdio MCP servers are universally accepted

All three real harnesses accepted `quintal-tools` as an `McpServerStdio` entry
(`{ name, command, args, env }`, all four required) even though none of them
advertise `mcpCapabilities.stdio` — the spec makes stdio mandatory, so there is
no capability to advertise. `mcpCapabilities` only ever listed `http` and `sse`.

`env` is an **array of `{ name, value }`**, not an object. Getting this wrong
produces a confusing failure inside the agent rather than a validation error.

### 5. The published docs are lossier than the schema

Building against the prose docs would have produced three bugs. Ground truth is
`@agentclientprotocol/sdk/schema/schema.json`:

| Docs said | Actually |
| --- | --- |
| `session/update` discriminated by `type` | discriminated by **`sessionUpdate`** |
| permission options have `label`/`description` | `optionId`, **`name`**, **`kind`** |
| stop reasons: `end_turn \| tool_use \| cancelled \| max_tokens \| stop_sequence` | `end_turn \| max_tokens \| **max_turn_requests** \| **refusal** \| cancelled` |
| permission outcome `approved \| denied \| cancelled` | **`selected`** (with `optionId`) or `cancelled` |
| `protocolVersion: "1.0.0"` | `1` (a number) |

### 7. Claude Code answers its own permission questions by default

`@agentclientprotocol/claude-agent-acp` 0.81 opens sessions in mode `auto`
("Claude handles permission decisions") and never sends
`session/request_permission` — verified by driving the adapter directly. An
agent with no `run` scope therefore got the same silent self-approval as one
with it, until the harness started selecting `default` ("Manual") for it via
`session/set_mode`. "Manual" asks before *changes*: a `Write` asks, an `echo`
does not. A user's `~/.claude/settings.json` `permissions.defaultMode` and
`allow` list also feed into this.

Of the option `kind`s a runtime may offer — `allow_once`, `allow_always`,
`reject_once`, `reject_always` — the kind is **not** what the harness reads.
It differs per runtime, and on a Claude Code plan-exit request three options
carry `allow_always` meaning "use auto mode", "clear context and use auto
mode" and "bypass permissions". The harness selects from a catalogue of
measured facts instead, takes the narrowest allow whose breadth and lifetime
are established, and names the button for what taking it does. See
[docs/RUNTIME-PERMISSIONS.md](../../docs/RUNTIME-PERMISSIONS.md).

### 8. Codex and opencode never ask over ACP

`@agentclientprotocol/codex-acp` 1.13.1 sent no `session/request_permission`
in any of its three modes — including `read-only`, which it describes as
"Always ask to edit external files", where it created a file **outside** its
working directory without asking. opencode 1.4.3 likewise never asked, in
either mode, for a write, a shell command or a write outside the workspace.
Verified 2026-09-24. Quintal's approval cards cannot reach either runtime;
their own settings are the only control.

### 9. Cursor speaks ACP, and hides it

Cursor's CLI registers `acp` as a *hidden* command — `agent --help` (and
`cursor-agent --help`; the installer links both names to one binary) never
lists it, which is why this catalogue said "no ACP surface" from 2026-08-07
until it was found in the bundle. It is documented at
<https://cursor.com/docs/cli/acp> and Zed drives it the same way.

Verified 2026-10-25 on Linux against Cursor CLI 2026.10.19 (handshake and
session creation) and 2026.10.16 (the permission probe, nine prompt turns):

- `initialize` answers protocol `1`, advertises `loadSession`, image prompts
  and the `cursor_login` auth method, and sends **no `agentInfo`** — so the
  adapter identity the host report carries is null for Cursor, and the
  permission catalogue's "has the adapter moved" check cannot see it move.
  `cursor-agent --version` is the only version signal.
- `session/new` requires the CLI to be signed in (`agent login`), accepts a
  stdio MCP server in the shape above (finding 4) — it spawned the probe's
  server and completed the MCP `initialize` exchange — and answers with
  `modes` (`agent`, `plan`, `ask`), `models` and `configOptions`. The model
  option is `{ id: "model", category: "model" }` with 46 choices, read by the
  same code path as the other adapters (`id` rather than `configId`).
- `session/set_mode` accepts `agent`, `plan` and `ask`. `plan` and `ask` are
  read-only, so they are the modes for an agent that must not change anything;
  there is no "ask before changes" mode like Claude Code's Manual.
- Like Codex and opencode (finding 8), it **never asked** over ACP: nine
  prompts across `agent`, `plan` and `ask` produced no
  `session/request_permission`, and in `agent` mode it wrote a file outside
  its working directory without asking. Its request handler exists (option
  ids `allow-once`, `allow-always`, `reject-once`) behind the CLI's own
  permission configuration. See
  [docs/RUNTIME-PERMISSIONS.md](../../docs/RUNTIME-PERMISSIONS.md).
- Cursor's docs say team-level MCP servers from its dashboard are not loaded
  in ACP mode. Project and user `.cursor/mcp.json` servers are.

### 6. Goose is unverified

Goose is not installed on the machine this was built on, so `goose acp` has
never been run. The default command is written from its documented interface and
should be treated as **untested**. If you run Goose, please report what happens.

---

## Re-running these checks

```bash
pnpm --filter quintal-acp build
node packages/acp-harness/dist/cli.js --key <AGENT_KEY> \
  --agent claude-code --cwd /path/to/repo --url http://localhost:3000
```

The scripted agent in `test/fixtures/fake-acp-agent.mjs` speaks the real wire
protocol and is driven by env vars (`FAKE_REPLY`, `FAKE_TOOL`, `FAKE_PERMISSION`,
`FAKE_CRASH_AFTER`, `FAKE_STOP_REASON`, `FAKE_DELAY_MS`). Use it to test the
harness without spending tokens; use a real harness to test compatibility.
