# Desks: where an agent's work is seen

An agent that is working should be seen working: at a desk, on a screen
you can walk up to and read. Today a busy agent stands wherever it spawned
with a balloon over its head, and the work itself is only visible in the
conversation it was asked in. This is the design for closing that gap, and
for the inverse: walking up to an empty desk and starting a task from it.

It is written against two offices that do some of this already, and against
what the codebase has. Nothing here needs the harness to run the agent's
loop, and none of it costs a token.

## The stance

- **The screen is state, not a terminal.** Quintal never owns the agent's
  process; it speaks ACP. There is no PTY to mirror onto a laptop, and there
  should not be. What there is instead is the activity stream: tool steps
  with a state, a title and a detail, already throttled, stored and rendered
  in the conversations panel. A monitor renders that. It is a better monitor
  than a terminal, because it can show *what state the agent is in* rather
  than scrollback.
- **Posture is presence, and presence is free.** Walking to a desk, sitting,
  typing and standing up are driven by the status line and the task the
  office already knows. The harness narrates nothing new.
- **The glass is public; the words are not.** Everyone in the office sees
  that a monitor is lit and what colour. The steps on it reach only the
  people who could read the conversation they belong to. A laptop in the
  Agent Bay must not be a way to read a DM from behind.
- **A desk is a seat, not a branch.** The worktree is still the task's
  (`task_begin`, `!task`, a board hand-over). A desk is where the agent sits
  while it has one. Agents outnumbering desks stand; nothing is refused for
  want of a chair.

## What the references do

**agent-office** (AgentSystemLabs, MIT, three.js) owns each worker's terminal
with `node-pty`, mirrors it in a headless xterm on the server, and pushes
per-row screen diffs onto the laptop mesh a few times a second. Pressing `E`
at a desk opens the real shared terminal. The office hires by walking to an
empty desk and pressing `E`, with a prompt box, a model and an effort; `P`
at an occupied desk gives that worker another task. Status comes from Claude
Code hooks posted to a loopback server, and a shared module maps the latest
tool call to a pose: reading flips through papers, editing types flat out,
tests running leans back, web search spins a globe, two failures in a row
puts its head in its hands, waiting on you jumps and then taps a foot. A
worker that needs input lights a red pillar over its desk with rings on the
floor and a banner on screen; `N` walks you to it. A worker sent home closes
its laptop and walks out with a box.

**The Agent Office** (Six One Inc, Mac, free) is ticket in, pull request
out. A worker "walks over to take it" and "sits down in her own git
worktree", "raises a hand when she needs you", and approvals are cards with
Approve and Deny. Its site says nothing about watching a worker's steps.
What it does well is presentation: six room styles plus Manga and Cyberpunk,
an office built from a description, a showcase of offices people designed,
a cat that naps in sun patches, a trophy cabinet, a release every day or two.

**Agent Office 3D** (a VS Code extension) is the closest to this document:
it observes Claude Code through hooks and transcript files, sits the
character typing while it works, stands it up to wander when idle, and lights
the monitor in the status colour. Clicking the character opens an inspector
with the task, tokens, turns and tool calls.

The lesson from all three: the desk is the unit people read. Sitting says
"on something", the screen says "what", the beacon says "needs you", and the
empty chair says "give me something".

## What the codebase has

- **Sit and work frames** in every avatar sheet: columns 4-5 and 6-7, with
  timings in `apps/web/src/game/constants.ts`. Only `idle` and `walk` are
  ever created (`OfficeScene.#createAnimations`); `Avatar.setFacing` knows
  only `moving`.
- **Ten desks, chairs and laptops** in the Agent Bay, placed as props by
  `tools/build-hq-map.mjs`. No seat, desk or monitor object; chair tiles
  block movement; agents spawn on any free bay tile.
- **One interactable kind**, `board`, with a doorstep, a prop and a halo,
  wired client-side through the `interactable` and `interact` bridge events.
  Only the noticeboard is clickable in the scene. Avatars are not.
- **Busy and idle** are read off the status line (`idleCapable`) once a
  second in `idle-life.ts`; a busy agent stops wandering, nothing more.
- **The activity stream**: `PublicTurn` per scope in the harness, the
  `agent:activity` message, `#activity` in the room, the `agent_activity`
  table, fan-out to channel members or earshot, `TurnActivity` on the
  client at the viewer's Low, Balanced or Detailed level. Keyed by
  conversation; nothing asks for an agent's current turn.
- **The task** on the agent's card and the board's Agents tab: title, branch,
  pull request. And `openConversation(key)` on the client, with keys that
  already match the harness's scope ids, though nothing converts
  `workingIn` into one.
- **A board hand-over** is a line in your DM with the agent, with the note as
  a brief that tells it to `task_begin` with the note's number
  (`board-brief.ts`). The agent chooses the repository.

## The design

### Seats on the map

A `seats` object layer, generated for the ten Agent Bay desks and later the
open office, one point per chair:

```
{ seatId: "bay-3", facing: "up", screenX, screenY, screenWidth, screenHeight }
```

The point is the chair's tile. The map builder leaves it out of the
collision layer and the parser blocks it in the walkable grid instead, so
nobody paths through a chair and a click on one walks you up beside it;
the office opens that one tile for the one agent it has given the desk to
(`withSeatOpen`) when it routes it there. The chair sits on a whole tile,
not the desk's centre line, so the sitter is square on it. `screen` is the
desk's monitor in map pixels, measured off the desk sprite by the builder,
for the glow and the click to come; the laptops that used to peek out from
behind the Agent Bay desks are gone, since the desks have screens of their
own. The doorstep a *person* stands on to
use a desk is a `desk` interactable, which arrives with the panel in phase
3; a seat is where the agent is, not where you stand to look.

The server owns seating. A desk has a holder or none, kept in room state
beside the board, and the rules are pure (`seats.ts`, pinned in tests):

- An agent is given a **home desk** the first time it needs one, and keeps
  it while it is in the office. Same desk tomorrow. This is the roadmap's
  "a place that is yours", for agents first.
- No free desk: the agent stands where it is, and takes the next desk that
  frees. Never a refusal.
- An agent that leaves the office frees its desk.

### Posture

Three states, read from what the office already knows, decided in the tick
beside idle life:

| The agent is | Posture | Why |
| --- | --- | --- |
| busy (status not idle-capable) | walks to its desk, **work** frames | a turn is running |
| on a task, idle | sits at its desk, **sit** frames | the harness rule that a task for days must still read as idle; the chair says "on something", the stillness says "not right now" |
| no task, idle | stands up, wanders as today | free |
| waiting for its owner | sits, question balloon as today, **beacon** over the desk | you cannot miss who needs you |

Two fields appended to `OfficePlayer`: `seat` (the desk id, or empty) and
`pose` (`stand`, `sit`, `work`). The client creates the two missing
animations and `setFacing` takes the pose, drawing walk over any of them;
the sheets were drawn for this (see `world-assets.md`, "Seating
integration"). Depth needs nothing special: the chair's anchor is a row
below the sitter's feet, so the chair back draws over the legs, and the
desk's is a row above, so it draws behind.

The pose follows the state, never the clock: the office compares what the
state calls for with what it last called for, once a second, and acts on the
change. A change to `work` or `sit` sends the agent to its desk, giving it
one from the book if it has none, and seats it on arrival facing the chair's
way; a change to `stand` gets it up and a step off the chair, and idle life
takes it from there. Between changes nothing moves, so an agent its model
walked across the room mid-turn stays where it was sent, standing, rather
than being dragged back; a seated agent that is moved by anything stands,
because a body cannot sit on a tile it is not on. A busy agent addressed by
a walk-up is not moved by it, so it stays in its chair. The rules are pure
(`seating.ts`) and pinned: the pose a state calls for, and a book of desks
that never seats two agents on one chair.

The book is sticky by the agent's id, not its session: a reconnect keeps
the chair, and an agent that leaves keeps its desk until a present agent
needs one and none is free, when the longest-absent holder's goes first.
An agent is absent only once its last session has gone — a fresh
connection can arrive while the old socket is still in its reconnection
grace, and that old session timing out must not put a present agent's
chair under somebody else. An agent that wants a desk when every one is
held by somebody present waits, and is asked about again every sweep:
nothing was arranged for it, so nothing is recorded as done, and the first
desk a leaver frees is its.

### Act-outs, by tool class

Optional, after the above. `statusForTool` already names the tool; a small
pure map from tool class to a cue, as agent-office's `actions.ts` does:
read means slow work frames, edit means fast, a shell command that runs
tests means sit frames with the "thinking" balloon, web means a small globe
over the laptop. Two failed test runs in a row is worth a head-in-hands
emote. All of it from the tool title the harness already sends.

### The monitor

The laptop prop gets a glow and a surface, driven by events, never per
frame (the desktop app may be painting in software; see `DESKTOP.md`):

- **Colour by state**, visible from across the room: thinking, a tool
  running, waiting for you, an error, idle. Agent Office 3D does this and it
  reads at a glance.
- **A flicker of lines** when a step lands, from a tiny RenderTexture
  updated on `agent:activity`. Unreadable by design at 32 pixels; it says
  "something is happening", like a real screen seen from the door.

Both are public. They carry no words.

### Click the desk

Avatars and desk screens are interactive, with one bridge event,
`inspect`, carrying the clicked session. A click on a body is a click on
that person or agent; a click on a desk's screen (the seat's `screen`
rectangle, from the map) is a click on whoever holds the desk, and the
pointer is a hand over it only while somebody does. It opens the **desk
panel**, at the left of the room, built from parts that exist:

1. The agent's card (`AgentCard`): name, owner, status, task, scopes,
   runtime, model, the audit log.
2. **The screen**: the agent's running turn, or its most recent, rendered
   by `TurnActivity` at your detail level, live. The panel reads it from
   the transcripts this client already holds, and from a copy held for
   the panel from the moment it opens (`useScreenTurn`), because a
   transcript keeps its newest 500 lines and a turn that has run while a
   busy channel said 500 things has fallen off it. Opening the panel sends
   `activity_follow { agentId }`, and the office answers with the agent's
   running turns, as `activity` messages, and `activity_followed`, which
   counts the ones it did not send. Asked again whenever the answer could
   have changed — a step taken, a conversation switched, the channels you
   are in — so the count moves by the same rule as the steps.
3. **Go to the conversation**: one button per conversation the agent can
   be read in — the one its shown turn is in, and the ones `workingIn`
   names that this client is a member of — which calls `openConversation`.
   The task's own thread, when it started from a board note, is the DM the
   hand-over landed in.

The privacy rule is `canSeeTurn`, one function the office asks on every
path — publishing a step, raising an approval card, answering a follow: a
turn in a channel or DM is for its members; a turn in a zone is for earshot
of where it began and for whoever is reading that zone. A turn the asker
may not read is a count in the reply and nothing else, and the panel says
"working in a conversation you are not in", not where. There is nothing to
unfollow: later steps reach the panel by the same rule, or do not.

Clicking a human opens their card; it is the same event. Not yet: a
keyboard path, `E` on a desk's doorstep, which wants the desk interactable
of phase 3.

### Click an empty desk: begin a task from the station

The inverse flow, and the one agent-office gets most right: an empty chair
is an invitation. Standing on the doorstep of a desk nobody holds, or
clicking it, opens the **begin-task panel**:

- **What**: a title and a description, typed; or **a note from the board**,
  picked from the open ones, which fills both and carries the number.
- **Who**: one of your agents that is free, meaning in the office, idle and
  on no task. An agent on a task is listed greyed with its task's title, so
  you can see why it is not offered. A team can be offered too: the team
  sorts out who takes it, as `@team` does today.
- **Begin**.

What happens is what happens already when a note is handed over, so nothing
new reaches the agent: the office writes the line in your DM with the agent,
with the brief attached (`assignmentBrief`, or a sibling for a typed task
that has no note). The agent is woken by being addressed, reads the brief,
and begins with `task_begin`. The desk is reserved for it on Begin, so it
walks there as the turn starts rather than to its home desk, and that desk
becomes its home desk if it had none. If the agent declines ("I cannot take
it"), the seat frees and the panel's thread is the DM, where you read why.

The repository is the agent's to choose, as it is for a board note today:
the brief says what the work is, the agent knows what is under `REPOS/`.
Offering a repository picker in the panel needs the harness to report its
checkouts' names to the office at boot, the way it reports runtimes, which
is a small addition and worth doing second: then the panel can say
"api, web" and the brief can name one.

The board stays the record. A typed task that was not a note becomes one,
in "in progress", assigned, so the Agents and the columns agree with the
room. Nothing is tracked only by a chair.

## Phases

1. **Seats and posture.** The `desk` interactable, seat reservation, the
   two schema fields, the two animations, walk-to-desk on busy and the three
   postures. Pure presence; the office feels inhabited and nothing else
   changes. Tests: the seating rules and the posture decision, pinned.
2. **Click to look.** The `inspect` event, the desk panel from existing
   parts, `activity_follow` with the privacy rule, and the conversation
   jump. Tests: a follower who is not a member never receives a step, the
   turn the screen shows, and where the buttons go.
3. **Begin from the station.** The begin-task panel over the existing
   hand-over, free-agent listing, seat reservation on Begin, a typed task
   becoming a note. Then the harness reporting checkouts.
4. **The glass.** Monitor colour and flicker, the waiting beacon, act-outs by
   tool class.

Phase 1 alone is worth shipping. Phase 2 is the feature. Phase 3 turns the
room into the place work starts, not only where it is watched. Phase 4 is
what makes the laptop worth clicking.

## Deliberately not

- **A terminal on the laptop.** It would mean owning the process, which the
  harness does not and will not. The activity stream is the screen.
- **A desk per conversation.** One agent, one body, one desk, however many
  conversations it answers at once.
- **Sitting for people**, yet. The seat machinery will carry it; the desks
  are the agents' first, because that is what the room is for.
- **Posture from the model.** No tool for an agent to sit down. Its status
  and its task decide, so it cannot look busy while idle or idle while busy.
