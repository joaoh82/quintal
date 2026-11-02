# Desks: where an agent's work is seen

An agent that is working should be seen working: at a desk, on a screen
you can walk up to and read. Before this, a busy agent stood wherever it
spawned with a balloon over its head, and the work itself was visible only
in the conversation it was asked in. This is the design for closing that
gap, and for the inverse — walking up to an empty desk and starting a task
from it — and, since all four phases shipped, the record of what was built
and why. Where the text names a file or a function, it is the one in the
tree.

It was written against three offices that do some of this already, and
against what the codebase had. Nothing here needs the harness to run the
agent's loop, and none of it costs a token.

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

## What the codebase had

The starting point, kept because the design below leans on it; each
bullet says what was there before phase 1, not what is there now.

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
for the glow and the click; the laptops that used to peek out from behind
the Agent Bay desks are gone, since the desks have screens of their own.
The doorstep a *person* stands on to use a desk is the `desk` interactable
every seat makes (`deskOf`, under "Click the desk"); a seat is where the
agent is, not where you stand to look.

The server owns seating. A desk has a holder or none, in the room's
`SeatBook`, and the rules are pure (`seating.ts`, pinned in tests):

- An agent is given a **home desk** the first time it needs one, and keeps
  it while it is in the office. Same desk tomorrow. This is the roadmap's
  "a place that is yours", for agents first.
- No free desk: the agent stands where it is, and takes the next desk that
  frees. Never a refusal.
- An agent that leaves the office keeps its desk until a present agent
  needs one and none is free; the book under "Posture" says how.

### Posture

Three states, read from what the office already knows, decided in the tick
beside idle life:

| The agent is | Posture | Why |
| --- | --- | --- |
| busy (status not idle-capable) | walks to its desk, **work** frames | a turn is running |
| on a task, idle | sits at its desk, **sit** frames | the harness rule that a task for days must still read as idle; the chair says "on something", the stillness says "not right now" |
| no task, idle | stands up, wanders as today | free |
| waiting for its owner | sits, question balloon as today, **beacon** over the desk | you cannot miss who needs you |

Two fields on `OfficePlayer`: `seat` (the desk the office has given it, by
seat id, or empty — its, not necessarily under it) and `pose` (`stand`,
`sit`, `work`). The client creates the sit and work animations beside idle
and walk, and `setFacing` takes the pose, drawing walk over any of them;
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

A small pure map from the status line to a cue (`cueFor` in `glass.ts`),
as agent-office's `actions.ts` does, from the verb `statusForTool` already
chose: reading and searching are slow work frames, editing is fast, a
shell command that runs a test suite is sit frames — sitting back while
they run — and fetching puts a small globe over the laptop. The avatar
takes the cue when its status line changes (`setCue`) and redraws only
what is at a desk: a body walking or standing is drawn as it was. Work has
three paces, so it is three animations per direction.

Not from this: the "thinking" balloon on a test run, which the harness
sets from the same status line and would have to set itself; and
head-in-hands after two failed runs, which needs the test's outcome, and
that is a step in the activity stream, not something public.

### The monitor

The laptop prop gets a glow and a surface, driven by events, never per
frame (the desktop app may be painting in software; see `DESKTOP.md`):

- **Colour by state**, visible from across the room (`glassState`): dark
  with nobody at it or its holder on its feet; dim under one sitting on a
  task with nothing running; then by the status line, through the same
  table that picks the balloon — thinking, a tool at work, waiting for
  somebody, a refusal or a stop. Agent Office 3D does this and it reads at
  a glance.
- **A flicker of lines** when a step lands: a few random short lines over
  the screen, gone in a quarter of a second. Unreadable by design at 32
  pixels; it says "something is happening", like a real screen seen from
  the door. Fired by a change of the status line, which the nameplate
  already shows everybody, rather than by `agent:activity`, which reaches
  only those who may read the conversation: so it is public and tells
  nobody anything new.
- **The beacon**: while the holder's status says "waiting for …", a column
  of light stands over the desk and breathes, tall enough to be seen from
  the door. It lights for whoever is being waited for, and looks the same
  to every viewer; the question balloon says the same thing up close. It
  is over the desk, so an agent waiting on its feet — one that may not
  move, or one its model walked elsewhere mid-turn — has the balloon and
  no beacon.

All of it is public. It carries no words, and nothing the status line,
the pose and the seat did not already say.

### Click the desk

Avatars and desk screens are interactive, with one bridge event,
`inspect`, carrying the clicked session. A click on a body is a click on
that person or agent; a click on a desk's screen (the seat's `screen`
rectangle, from the map) is a click on whoever holds the desk — or, when
nobody does, on the desk itself, which is where a task begins (below). It
opens the **desk panel**, at the left of the room, built from parts that
exist:

1. The agent's card (`AgentCard`): name, owner, status, task, scopes,
   runtime, model, the audit log.
2. **The screen**: the agent's running turn, or its most recent, rendered
   by `TurnActivity` at your detail level, live, and captioned with the
   routine it is when the turn says so (`routineCaption`, from the state
   the row shows). The panel reads the turn from the transcripts this
   client already holds, and from a copy held for
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

Clicking a human opens their card; it is the same event. The keyboard
path is the desk interactable: every seat makes one (`deskOf`), named for
its seat, with a tile beside the chair as its doorstep — behind it, or a
side when behind it is not floor — and the screen as its halo. Stand there
and the screen lights up as the noticeboard does, and the offer under `E`
reads "see what Arthur is on" — or, when nobody holds the desk, "begin a
task at this desk", which is the next section.

### Click an empty desk: begin a task from the station

The inverse flow, and the one agent-office gets most right: an empty chair
is an invitation. Standing behind the chair of a desk nobody holds, or
clicking its screen, opens the **station panel** (`StationPanel`), in the
desk panel's place at the left of the room:

- **What**: a note from the board, picked from the open ones that are
  nobody's or one of your agents' already, which fills the title and the
  details and carries the number; or a title and details typed here.
- **Who**: your agents that are in the office, free ones first. Free means
  idle — the status line empty (`idleStatus`) — and on no task, and one the
  hand-over can wake and the desk can take: with the `dm` scope, or nothing
  reaches it, and with `move`, or it never walks. A standing refusal such
  as "no model … here" is not work, so idle life may wander it, but it is
  not an agent that would answer either. An agent that is not offered is
  listed greyed with why — "on Fix the chair", "reading auth.ts", "cannot
  be messaged" — and one that is not here is not listed, because nothing
  can be begun for it from a chair it cannot walk to. The rules are
  `candidates` and `offeredNotes` in the client's `station.ts`, pinned
  without a panel; the office refuses the same ones (`whyNotBegin`,
  `whyNotNote` in the room's `station.ts`), before it writes anything.
- **Which routine**, when that is what an agent is on: "on its routine
  Inbox sweep", not "working". A routine fires as a line in its owner's
  DM and the status line says only `working`, so the turn says which
  routine it is (`AgentActivity.routine`, set by the harness from the
  brief the line carried) and `routineOn` reads it from the running turn
  this client holds for the agent — which, for the owner, is their own
  DM. Never from the clocks: the busy stamp is held across a second turn,
  so a join on it named the wrong work.
- **Where**, when the agent's machine has said what it has checked out:
  a repository, with the agent's own choice first. The next section but
  one says how the office knows.
- **Begin**, which sends one message, `desk_begin { seatId, agentId,
  itemId | title, body, repo? }`.

What happens is what happens already when a note is handed over, so nothing
new reaches the agent. The office checks that the asker may hand this agent
work (`#mayHandTo`: its owner, and nobody else), that a picked note is still
open, that the agent can take it, and that nobody present holds the desk —
and takes the desk in the same tick as that last check, before the board
is written, because the seating sweep runs between any two awaits and gives
the first free desk to whoever wants one (`SeatBook.reserve`: the agent's
from this moment, whatever it held before, and that one is free again; given
back if the write fails). A picked note is assigned; a typed one is written
to the board, in "in progress" and assigned, so the Agents tab and the
columns agree with the room. Then the note is handed over exactly as from
the board: a line in your DM with the agent, the brief attached
(`assignmentBrief`; a typed task has become a note, so the same brief
serves). A note already in that agent's hands is handed to it again, not
from it: the brief goes, and no "has gone to" follows it. The line wakes
the agent; the seating sweep that follows sends it to the desk it holds
*now*, which is this one. The reply, `desk_begun`, names the note and the
DM the line landed in, and the client opens that DM: the agent's answer —
picked up, or why it cannot take it — lands there.

The desk is the agent's the way any desk it is given is: held while it is in
the office, and after, until a present agent needs it more. An agent that
declines keeps the desk until it leaves, as it would have kept the desk it
walked to for any other turn; nothing frees a chair on the strength of a
sentence.

A team is not offered. A board note is one agent's, the hand-over is one DM,
and the desk is one chair; "the team sorts out who takes it" is a mention in
a channel, which is a different thing from a chair and already works as one.

The repository is the agent's to choose, as it is for a board note, unless
you choose it. The harness reports the checkouts under `REPOS/` with its
machine: `checkouts` on `agent:host_report`, once per fleet, the names
`workspace_info` lists ("api", "group/web"). The office keeps them on the
machine's row — one row per owner per label, so two people's laptops can
share a name and never overwrite each other — and joins them onto each of
the board's agent rows by the machine that agent last reported from, under
the same owner. They go only to that owner: a machine's name and runtimes
are the office's to see, what is cloned on it is not. The station offers
them for the chosen agent, with the agent's own choice first. A name picked
rides in `desk_begin` as `repo`, the office refuses one the machine never
listed (`whyNotRepo`), and the brief says "Work in the api checkout under
REPOS/: pass repo "api" to task_begin." Nothing else changes: the agent
still begins with `task_begin`, which is what takes a repository.

The board stays the record. Nothing is tracked only by a chair.

## Phases

All shipped, in this order; the pull requests are the detailed record.

1. **Seats and posture** (#183). The `seats` layer and the seat book, the
   two schema fields, the two animations, walk-to-desk on busy and the
   three postures. Pure presence; the office feels inhabited and nothing
   else changes. Tests: the seating rules and the posture decision, pinned.
2. **Click to look** (#185). The `inspect` event, the desk panel from
   existing parts, `activity_follow` with the privacy rule, and the
   conversation jump. Tests: a follower who is not a member never receives
   a step, the turn the screen shows, and where the buttons go.
3. **Begin from the station** (#188). The `desk` interactable from every
   seat, the station panel over the existing hand-over, free-agent listing,
   seat reservation on Begin, a typed task becoming a note. Then the harness
   reporting its checkouts and the station offering them (#191, #192).
   Tests: what a desk is told to begin, who the station offers, the
   reserved desk being the one the agent walks to, and the checkouts a
   machine names.
4. **The glass** (#190). Monitor colour and flicker, the waiting beacon,
   act-outs by tool class. Tests: the state a desk shows, and the cue a
   status line calls for.

After them, the routine an agent is on, named at the station (#193) and on
the desk panel (#194).

Phase 1 alone was worth shipping. Phase 2 is the feature. Phase 3 turns the
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
- **Reading a routine off the clocks.** The busy stamp does not mark turn
  boundaries, and a join on it named a question after a routine. The turn
  that a routine's line started says which routine it is; nothing else
  needs to guess.
