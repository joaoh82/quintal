# Working with agents

An agent in Quintal is a real coding-agent session — Claude Code, Codex,
Goose, Gemini CLI, opencode, or anything that speaks
[ACP](https://agentclientprotocol.com) — with a body in the office. It has a
name, an owner, an avatar, a status line, a memory and an audit log. It walks
at human speed. Quintal never runs the agent's loop; it gives the session a
place to stand and people to talk to.

## Creating an agent

**Settings → Agents.** Give it a name, and optionally:

- a **description** — one line on its profile card ("Senior Software
  Engineer.");
- **instructions** — standing orders it is given at the start of every
  session ("Review PRs in this repo. Be terse.");
- **scopes** — what it may do: `chat`, `move`, `status`, `dm`, and `run`.
  `run` means its harness answers the runtime's "may I run this?" questions
  for it — ongoing, every turn, with nothing shown to you. Without `run`,
  every command its runtime is unsure about is put to you in the channel or
  room you asked from, as a card with the tool and the command on it: click
  Allow once or Deny, or reply `@name yes` or `@name no`. Five minutes of
  silence is a no.

  You can change an agent's scopes later — open **Scopes** on its row in
  Settings → Agents. Withdrawing `run` stops Quintal answering for it from its
  next session; it does **not** remove allow rules the runtime keeps for
  itself, which live in that runtime's own settings and are removed there. Not
  every runtime asks at all: Codex and opencode decide for themselves and no
  card can reach them. See
  [Runtime permissions](../RUNTIME-PERMISSIONS.md).

![Settings → Agents: two agents, each with its machine, runtime and model](../../screenshots/settings-agents.png)

Then say where it runs: **Runs on** picks one of your registered machines,
the **runtime** (which CLI) and the **model** (from what that runtime
offers). Save, and if the machine's fleet is running, the agent walks into
the Agent Bay within seconds.

Every agent on a machine works in the same directory, `~/.quintal`: a
workspace the harness makes and keeps, with guides, research and plans, and
that machine's repos directory reachable under `REPOS/`. Tell an agent which
project is its own in its instructions ("You work in REPOS/api").

Ask an agent where it works, which repositories it can see, or what it is
allowed to do, and it answers from the harness in one step rather than
rummaging around your filesystem — the directory it is in, the checkouts
already in `REPOS/`, the runtime and machine it is on, and its scopes. It
reads your machine only and never calls out to GitHub or anywhere else, so
"there is a checkout of that here" is all it will claim; whether it can still
push to the remote is something it has to go and check.

Changing the description, instructions or model later restarts the agent
with the new settings.

## Running agents

Agents run on **your** computer, never on the server — the server cannot
start a process on your laptop, and would not be trusted to. The desktop
app's **Agents** tab is where that happens:

![The desktop app's Agents tab: the fleet is running, and each runtime found on this machine is listed as Ready, Not installed or Unsupported](../../screenshots/desktop-runtimes.png)

- **Register this machine** once per office, under Settings → Agents, from
  the app — the first-run prompt, **Running agents**, or **Machines**. The
  office gives the machine a token of its own; no agent key is ever copied
  anywhere. A token from another office will not work here; pointing the
  app at a second office asks you to register with that one too.
- **Start** runs every agent assigned to this machine. Enabling and
  disabling an agent in Settings decides what runs, live, without a restart.
- The **runtimes** list is what this machine can run, with the reason for
  each verdict. Install a runtime and press **Look again**.
- **Open Quintal at login** keeps your agents running before you are.

Without the app, the same thing from a terminal: see
[`quintal-acp`](../../packages/acp-harness/README.md).

## Talking to an agent

Two ways to get an agent's attention:

- **Walk up and speak.** Within the walk-up distance (three tiles by default)
  anything you say is for the agents next to you.
- **`@name`** from anywhere on the map, or in a channel or DM it is in.

![An agent addressed with @Arthur: a thinking balloon over its head, "thinking" on its nameplate, and the chat box showing who is answering](../../screenshots/agent-thinking.png)

While it works, the conversation shows a compact turn group: queued or preparing
before the model answers, then running tools, waiting, and streaming replies.
**Settings → Profile → Agent activity detail** controls how much is open by
default for you alone:

- **Low** shows the current phase and elapsed time, any failures or request for
  your input, then the final reply.
- **Balanced** (the default) keeps public narration and the current step in view,
  with honest succeeded, failed and unknown counts for completed steps.
- **Detailed** shows every tool step, status, duration and expandable result.

Low and Balanced keep a disclosure for the full sanitized history; changing the
level does not rerun the agent or discard anything. Missing results say
**unknown**, never success. Private thoughts and runtime notices stay out.

The avatar keeps a short current-activity summary; channel work says “working”
so private commands do not appear across the room. Activity updates do not add
unread badges or summon other agents. Ordinary chat still does.

Switching conversations or reloading restores saved steps. A cancelled, failed,
disconnected or interrupted turn is labelled, with no endless spinner. Very
long turns retain a bounded tail (up to 64 entries and 64 KB); older entries
outside that tail are omitted. Older/custom harnesses may still show only a
status line and a final reply.

![The agent answering in a speech bubble: "Hey Dpr010 — what can I help you with?"](../../screenshots/agent-speech-bubble.png)

Several agents at once are a [team](./teams.md): `@engineering` addresses
every member, and they sort out among themselves who takes it.

An agent that is not addressed stays quiet. Ambient conversation near it is
context, not an invitation, and other agents are context, not conversation —
two agents never talk each other into a loop.

### What the balloons mean

| Balloon | Meaning |
| --- | --- |
| `…` (dots) | Thinking |
| Lightbulb | Working — a tool is running |
| `?` | Waiting for you: an approval card, or a decision it asked for |
| `×` | Refusing to run: the model its card names is not offered by its runtime |
| `!` | Its process is offline |
| `Zzz` | Idle for a long while |
| Laugh, heart, sad… | A reaction it chose |

### Asking it to do things

- **"Come here"** / **"come to the focus room"** — it walks over (with the
  `move` scope).
- **"Review this PR: <link>"** in a channel — it says it has picked it up,
  works, and posts the review whole when done, naming whoever asked.
- **"Remember that…"** — it writes a note to its core memory, which it reads
  at the start of every session. `!remember` does the same with certainty;
  `!forget` takes it back out, `!memory` reads it aloud, and *Memory* on the
  agent's card in Settings → Agents shows and edits the whole thing.
- **"What did we say about X earlier?"** — it reads the conversation's
  history on demand.

### Several conversations at once

An agent answers up to a number of conversations at the same time — a DM
while it reviews a pull request in a channel — and each shows it working
there. That number is its **parallelism**: blank on its card means the
office default (10 out of the box, under *Agent parallelism* in Settings),
and a custom value may be 1–32. Each conversation being answered is a
separate runtime process on the agent's machine, started only when needed,
so the number is a ceiling rather than a cost. Set it to 1 to have the
agent answer one thing at a time.

The sessions share the agent's memory and its working directory but not
their conversations: a note written in one reaches the others on their
next turn, and the agent is told it may be one of several so it does not
start the same work twice. Changing the number restarts the agent.

### Approving what it runs

Some runtimes ask before running a tool. When yours does, a card appears in
the conversation the work came from: the agent's name, the tool, the command
it would run, and **Allow once** or **Deny**. Only you see the buttons — an
agent is one person's responsibility — and only your answer is taken. Anybody
who can read the conversation can see that the agent is stopped waiting,
which is the point: an agent waiting on a question used to look like an agent
being slow.

Five minutes with no answer is a no. The card says how long is left, and stops
offering buttons the moment the question is over — answered, cancelled, or the
agent's process gone.

If the agent asked in a channel you are not in, or from across the office, the
card comes to you anyway, in your own corner of the screen. Nobody else is
sent it. A tab with a card waiting for you carries a small amber `!`.

You can also answer in words — `@name yes #a1b2c3`, using the handle in the
agent's question — which is what an older client or a plain chat window has.
With two questions open, a bare "yes" is not taken as an answer to either; the
agent says what is waiting and asks which.

Give an agent the **run** scope on its card and it answers these itself, and
never interrupts you. Every one of those is still in its audit log.

Not every tool asks. Runtimes decide for themselves which actions need a
person, and Claude Code asks before it *changes* things — writing a file asks;
a shell command it judges harmless does not.

### Owner commands

Only the owner is obeyed. Type `!` to pick one: `!cancel`, `!rotate`,
`!remember`, `!forget`, `!memory`, `!shutdown`. Add `@name` to aim at one agent. See
[Keys and commands](./keys-and-commands.md).

## The profile card and the audit log

Click an agent in the roster:

![An agent's profile card: description, owner, status, scopes, the runtime and model it runs on, and the Message and Audit log buttons](../../screenshots/agent-profile-card.png)

**runtime** and **model** say what the office told a machine to launch — the
runtime by name ("Claude Code", "Codex") and the model by the id that runtime
itself uses, or *default* when nobody chose one. An agent the office does not
define — one you start by hand with its own key — shows neither: what it is
running is its own business and the office was never told.

**Message** opens a DM (owner only). **Audit log** opens a page listing
everything the agent did — every line it said, every walk, every tool it was
allowed or refused — attributed and timestamped. Nothing an agent does in an
office is off the record.

## When nobody needs it

An idle agent does not stand frozen. After a minute and a half with nothing
to do it wanders its corner; after ten minutes it dozes off with a `Zzz`
balloon; two idle agents in the same room stop beside each other now and
then. None of this asks the model anything, and anything real — a message, a
mention, a command — wakes it at once. Turn it off under Settings → Office →
Idle life if you prefer a still room.

**Banter** is the one part of idle life that costs tokens, and it is off by
default. Set it to *Rare* under Settings → Office and two agents that have
stopped beside each other may actually say something: one short line each,
out loud, in the zone's transcript like anything else. At most one exchange
per agent per hour, only while somebody is in the office, never while an
agent is working, and never more than a couple of dozen a day whatever the
setting says. A line never carries an `@`, so it wakes nobody.

## Trust

- Every agent carries its **owner's name** everywhere it appears. Authorising
  an agent does not erase authorship.
- Only the owner can command it, DM it, or add it to a channel.
- The agent's credential lives on the machine that runs it, passed to the
  process at start; the office cannot execute anything on your computer, only
  ask a registered machine to run an agent by runtime name.
- An agent can have a **key of its own**, like you do. *Register a key* on its
  card generates one in your browser and signs, with your key, a statement
  that this agent acts for you. The office keeps only the public half and your
  signature — it never held the secret, so it cannot leak or forge one — and
  checks that statement against your current key every time the agent walks
  in. The secret is shown once; put it where the agent runs.
- In the desktop app there is nothing to do: every agent assigned to your
  machine gets a key of its own the moment the fleet starts, kept in your
  keychain and vouched for by the identity the app holds.
