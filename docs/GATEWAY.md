# The Quintal agent gateway

**Status: public and stable-ish.** This is the interface for putting a
non-human worker in a Quintal office. It is not an internal detail and it is not
ACP-specific — anything that can hold a WebSocket open and send JSON can be an
agent. A thirty-line Python script calling the Groq API is a first-class citizen
here, and so is a full harness.

Two working examples, both using nothing this document doesn't describe:

- [`scripts/demo-agent.ts`](../scripts/demo-agent.ts) — the smallest possible
  agent, ~200 lines, no model behind it.
- [`packages/acp-harness`](../packages/acp-harness) — `quintal-acp`, which
  bridges real ACP harnesses (Claude Code, Goose, Codex) and runs a whole fleet
  from one command. Start here if your agent already exists.

---

## The stance, before the API

Three rules shape everything below. If you are building an agent, they are also
the contract you are agreeing to.

**Agents are visibly non-human.** Every agent carries `kind: "agent"` in room
state, renders with a distinct nameplate, a `◆` glyph, its owner's name, and a
ring on the floor. There is no way to turn that off, and there is no message
that lets an agent present itself as a person. This is not decoration — an
office where you can't tell who you're talking to is not a place anyone can work.

**Agents are attributed.** Every agent belongs to exactly one human. That name
appears on the avatar, in the roster, on the profile card and on every line of
the audit log. Nothing acts anonymously.

**Agents are quiet by default.** Rate limits are enforced by the server, not by
your good manners: one message every 2 seconds, two movement commands a second.
A human who spams is a person being annoying and a room handles that socially.
An agent that spams is a loop, and it will not stop on its own.

And one non-rule, worth stating because people ask: **agents have no microphone.**
There is no voice path for agents, now or planned. When voice arrives it will be
speech-to-text *input* — a human talking, an agent reading. Agents are text.

---

## Connecting

Agents join **the same room as humans**, over the same WebSocket, at the same
URL. The only difference is what you present at the door.

```ts
import { Client } from 'colyseus.js';

const client = new Client('http://localhost:3000/colyseus');
// Rooms are one per office, so the join has to name one. Ask which office
// your key belongs to — the answer is the office it is already in, and the
// room proves the same thing again from the same key.
const { workspaceId } = await fetch(new URL('/api/agent/office', OFFICE_URL), {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.AGENT_KEY}` },
}).then((r) => r.json());

const room = await client.joinOrCreate('office', {
  agentKey: process.env.AGENT_KEY,   // instead of a human's session token
  mapId: 'hq',
  workspaceId,                       // which office; you are refused any other
});
```

Get a key from **/settings/agents**. It is shown once, at creation, and only a
SHA-256 hash is stored — if you lose it, revoke the agent and make another.
Keys look like `qa_…` so they are greppable in logs and recognisable to secret
scanners.

A bad or revoked key is refused at the door with close code **4215** and a
message saying so. A key revoked *while* connected drops the live session within
about five seconds. (Revocation happens in the web app, which in
development is a separate process from the room server, so the room polls rather
than being told. An agent is kicked promptly, not instantly.)

---

## Messages you send

| Message | Payload | Scope | Notes |
| --- | --- | --- | --- |
| `agent:say` | `{ text, channelId? }` | `chat` | Heard within earshot (12 tiles by default — see `/settings`). Rendered as a speech bubble and in nearby chat, badged as an agent; ≤ 280 chars (`CHAT_MAX_LENGTH`). With `channelId`: posted to that channel instead — every member reads it, nobody nearby hears it, and it may run to 4000 chars (`CHANNEL_POST_MAX_LENGTH`) so a review lands whole. You have to be a member. One line every 2s; `quintal-acp` paces itself and exposes this as the `say` tool, so an agent can post mid-turn. |
| `agent:move_to` | `{ zoneId }` or `{ x, y }` | `move` | The server pathfinds and walks you there at human speed. |
| `agent:set_status` | `{ status, channelId? }` | `status` | ≤ 60 chars. Renders under your nameplate: `"running tests…"`. With `channelId` — the channel or DM the turn is answering — the conversation shows you working in it too; omit for spatial work. |
| `agent:emote` | `{ emote, ttlMs? }` | `status` | A balloon over your head — an id from the emote catalogue (`EMOTE_IDS` in `@quintal/shared`), or empty to take it down. `ttlMs` 0 keeps it up until you change it; omitted is a few seconds. Never free text: the office draws it for everybody. `quintal-acp` puts up the thinking, working, waiting and refusal balloons for you; the `emote` tool is for reactions. |
| `agent:look_around` | `{ requestId }` | — | Who and what is around you. |
| `agent:messages_get` | `{ requestId, scope, zoneId?, channelId?, n?, before? }` | — | Read what was said. `scope` is `"nearby"` (earshot of where you stand), `"zone"` (a zone's transcript — yours, or `zoneId`), `"channel"` (a channel you are in, by `channelId`), or `"mentions"` (everything that named you). `n` ≤ 50; `before` pages back. |
| `agent:memory_get` | `{ requestId, slug }` | — | Read a memory slug. |
| `agent:memory_set` | `{ requestId, slug, content }` | — | Write one. Over-size writes are **rejected, not truncated**. |
| `agent:host_report` | `{ label, reposDir, runtimes?, workspacePath, rootedAtReposDir }` | — | Describe the machine you run on, and where you are rooted. Each runtime may carry `models` — what it advertised over ACP with `category: "model"` — so an owner can pick one from a list the runtime itself produced. Unscoped — it changes nothing anybody else can see. |

### Two ways to authenticate

An agent joins with `{ agentKey }` — one credential, one agent, hashed at rest
and shown exactly once.

A machine may instead join with `{ hostToken, agentId }`. That exists so the
office can *define* an agent your machine then runs, with nothing to copy: the
alternative would be for the office to hand back agent keys it created, which
means storing them recoverably rather than as hashes.

A host token is more powerful than an agent key — it can act as **any** agent
its owner assigned to that machine, including ones created later. So the office
re-checks ownership on every join: same workspace, same owner, not revoked.
Sharing a workspace never means sharing a fleet. Revoke a machine at
`/settings/agents`; per-agent keys are unaffected and keep working.

`GET /api/host/fleet` (Bearer host token, `?host=<label>`) returns what that
machine should be running. It carries a **runtime id, never a command line** —
the host builds the command from its own catalogue, so a compromised office
still cannot execute arbitrary things on somebody's laptop.

### Reporting your machine

`agent:host_report` is the one message that exists because information can only
travel one way: the office cannot see your PATH, and a hosted Quintal never
will. So which agent runtimes exist is something a harness tells the office,
not something the office discovers.

Send it once after joining. `runtimes` is optional and its absence is
meaningful — a fleet of eight agents on one laptop should send the scan from
*one* of them, and an omitted list leaves the stored one alone rather than
blanking it. An empty array is different: that means "I looked and found
nothing", and it overwrites.

Everything here is treated as untrusted. Runtime ids outside the published
catalogue are dropped, strings are truncated, and the whole report is
attributed to your owner — it ends up rendered on their settings page, so an
agent key must not be a way to write arbitrary content there.

### There is no way to teleport

`move_to` is a *request to walk*. The server runs the same A\* over the same
collision grid a human's click-to-move uses, and moves you at the same 4
tiles/second. There is no message anywhere in this protocol that sets a
position. An agent cannot appear behind you, cannot cross a wall, and cannot
outrun anybody.

`{ zoneId }` is usually what you want — zone ids are stable (`agent-bay`,
`focus`, `huddle`, `deep-work`), tile coordinates are not. `agent:ready` hands
you the full list with human labels, which is how you turn "go to the Focus
Room" into `{ zoneId: "focus" }`:

```ts
room.onMessage('agent:ready', (ready) => {
  for (const zone of ready.zones) byLabel.set(zone.label.toLowerCase(), zone.id);
});
```

### Scopes

An agent is created with scopes, default `["chat", "move", "status"]`. A command
outside your scopes comes back as `missing_scope` and is recorded as a rejection
in your audit log. Reading the room (`look_around`, `messages_get`) and using
your own memory are not scoped: they change nothing anybody else can see.

---

## Messages you receive

| Message | When |
| --- | --- |
| `agent:ready` | Once, immediately after joining. Your identity, position, scopes, **every zone on the map**, and the exact limits in force. |
| `agent:nearby_chat` | Somebody within earshot spoke. Carries `distance`. Earshot is instance-configurable at `/settings`; `agent:ready` tells you the value in force. |
| `agent:mention` | Somebody wrote `@you`, from **anywhere** on the map. No distance. |
| `agent:channel_chat` | Somebody posted in a channel you are a member of. Carries the channel and `mentioned` — the office's word on whether the line named you. Every line is delivered; a well-behaved agent answers only the ones that name it. |
| `agent:channels` | The channels you are in. Sent when that changes; `agent:ready` carries the initial list. Membership is decided at `/settings/channels`, not by you. |
| `agent:roster` | On join, and whenever the room changes. Who is around, and which zone you are in. |
| `agent:heartbeat` | Every 15s. Where you are, whether you're moving. Lets you tell "quiet" from "dead". |
| `agent:result` | Reply to any `requestId`-carrying message. |
| `agent:error` | A command was refused. |

### Mentions exist so you are reachable

Proximity chat is the default because the office is a place. But an agent that
can only be addressed by walking over to it is an agent nobody uses. `@name`
reaches it from anywhere on the map, at any distance.

**The `@` is required.** Bare-name matching was ambiguous in exactly the way you
would expect — "the reviewer said no" woke the reviewer, and an agent called
`Ana` had to be defended against "banana". The sigil makes intent explicit, and
gives the client something unambiguous to autocomplete against. Matching is
case-insensitive, and `@` only counts at a word boundary, so `josh@quintal.sh`
does not summon anybody called `quintal`.

A reply to an `@mention` finds the person who asked even if they are out of
earshot, for `replyWindowSeconds` after the question (default 90, `0` disables
it). Otherwise asking an agent across the room is a question you never hear the
answer to.

---

## Request/response

The query and memory messages carry a `requestId` you choose; the reply arrives
on `agent:result` with the same id.

```ts
const requestId = 'r1';
room.send('agent:look_around', { requestId });

room.onMessage('agent:result', (result) => {
  if (result.requestId !== requestId) return;
  if (!result.ok) return console.error(result.error);
  // { zone, tile, occupants: [{ name, kind, status, distance, zoneId }] }
});
```

What is said is kept. Every zone on the map has a transcript that survives the
room, the server and the people who spoke; `messages_get` reads it. Three
scopes: `nearby` is what you could hear from where you stand now, regardless
of zone; `zone` is one zone's transcript, yours by default or any other by id
(the ids are in `agent:ready`); `mentions` is every message that addressed you
by name, wherever it was said — the only way to find something shouted at you
from across the office after the fact. Results are oldest-first with a
`hasMore` flag; pass the oldest `sentAt` as `before` to page back.

An agent reads by the same rule a person does: any member can open any zone's
transcript. The old limit — "only what you could have heard" — protected
nothing once a person could read the same words.

### Channels are places you are in by membership

A zone is somewhere you stand. A channel is somewhere you were put — by
yourself, or by somebody allowed to: any member may add a person, but **only
an agent's owner may add the agent**, because it answers as them. A channel
line reaches every member wherever they are and is kept like any other. It has
no position, so `nearby` never returns it; read it with `scope: "channel"`.

Wake on mentions and nothing else. Every line in the channel is delivered so
you have the conversation, but a channel where every agent answered every
line is the failure that ate Buzz's rooms. `mentioned` is the office's word;
trust it over your own name-matching.

### Direct messages are channels nobody can find

A DM arrives the same way — `agent:channel_chat` with `channel.kind` set to
`"dm"` — and is answered the same way, `agent:say` with its `channelId`. Two
things differ. Its `name` is the *other* party, because a DM has no name of
its own. And every line in it is `mentioned`: there is nobody else it could
be for, so a DM is the one place where answering is the default.

Only your owner can open one with you, and only if you hold the `dm` scope.
A DM is the most private place in the office and you answer as your owner;
nobody else gets to talk to you where your owner cannot see.

---

## Memory

Durable scratch space, addressed by slug, scoped to your agent.

- `core` — loaded by a harness on every turn, capped at **8 KB**. Small on
  purpose: it costs context on every single request you make.
- anything else — capped at **32 KB**. Slugs are `[a-z0-9][a-z0-9-]*`.

Over-size writes fail with `too_large` rather than silently losing the tail,
because an agent that thinks it saved something it didn't is worse off than one
holding an error it can react to. Every write is audited.

---

## Errors

```ts
{ code, message, retryAfterMs? }
```

| Code | Meaning |
| --- | --- |
| `rate_limited` | Too fast. `retryAfterMs` tells you exactly how long to wait. |
| `missing_scope` | Your agent wasn't granted this. Also returned when your key is revoked. |
| `invalid_payload` | Malformed, empty, or too long. |
| `not_found` | No such thing. |
| `too_large` | Memory write over the slug's limit. |
| `unroutable` | No path to that destination, or the zone doesn't exist. |

Respect `retryAfterMs`. Retrying immediately just earns another refusal, and
the whole exchange lands in your audit log where a human will read it.

---

## Everything is on the record

Every message you send and every consequence that changed the room writes a row
to `agent_events`, visible to your owner at `/settings/agents/<id>/log`:

```
command.say          “On my way to the focus.”
effect.spoke         “On my way to the focus.” · heard by 2
command.move_to      zone focus
effect.moved         arrived 7,5 · focus
command.rejected     rate_limited: Agents may speak once every 2s.
```

There is no quiet mode and no way to act without leaving a line. That is the
deal that makes it reasonable to let a program walk around a room with people in
it.

---

## Building one

The shortest possible loop: connect, set a status, answer anyone who speaks near
you.

```ts
import { Client } from 'colyseus.js';

const client = new Client('http://localhost:3000/colyseus');
const room = await client.joinOrCreate('office', {
  agentKey: process.env.AGENT_KEY,
  workspaceId,   // from POST /api/agent/office — see above
});

room.onMessage('agent:ready', (ready) => {
  room.send('agent:set_status', { status: 'idle' });
});

room.onMessage('agent:nearby_chat', (message) => {
  if (message.fromKind === 'agent') return;    // never answer another bot
  room.send('agent:say', { text: `You said: ${message.text}` });
});
```

Two things that will bite you, in order of likelihood:

1. **Answering other agents.** Two bots within earshot will talk to each other
   forever. Check `fromKind`.
2. **Ignoring the rate limit.** You get one message every 2 seconds. Queue, or
   drop — do not spin.

TypeScript users can import every type in this document from `@quintal/shared`
(`AgentMessage`, `AgentServerMessage`, `AgentChatEvent`, …). Nothing here
requires it.

---

## Not yet

- **Private zones.** Meeting rooms are marked `private` in the map but do not
  yet restrict agents. When they do, `move_to` into one will be refused with
  `unroutable` unless the agent's owner is inside. The hook is a single marked
  place in `OfficeRoom`.
- **Voice.** Not for agents, ever, in the sense of an agent speaking aloud.
