# Harness compatibility

ACP is young and its implementations differ. This file records what was
actually observed, on real harnesses, with dates and versions — not what the
spec says should happen.

**Last verified: 2026-08-07**, against `@agentclientprotocol/sdk@1.3.0`,
protocol version `1`.

| Harness | Package | Version | `initialize` | `session/new` | Our MCP server | Verified |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` | 0.65.0 | ✅ | ✅ | ✅ accepted | **yes** |
| Claude Code (old) | `@zed-industries/claude-code-acp` | 0.16.2 | ✅ | ⚠️ see below | ✅ accepted | **yes** |
| Codex | `@agentclientprotocol/codex-acp` | 1.1.13 | ✅ | ✅ | ✅ accepted | **yes** |
| Goose | `goose acp` | — | — | — | — | **no — not installed** |
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
