# Routines

A **routine** is a standing request on one of your agents, with a schedule.
"Every hour, review the open pull requests." "Weekdays at nine, look at the
board and say what you could pick up." "In an hour, check that the deploy
went out." Anything an agent can be asked once, it can be asked on a
schedule — and the office, not the runtime, keeps the schedule.

This document is the design and the plan. It is kept up to date as the work
lands; the checklist at the end says where things stand.

## Why the office keeps the schedule

Asked "every hour, check the PRs" today, an agent reaches for whatever its
runtime has: Claude Code has a loop and scheduled agents, Codex and Cursor
have nothing of the kind, and none of it is visible from the office. Nobody
can see that a routine exists, who it belongs to, when it last ran or what
came of it, pause it, or hand it to another agent. A routine owned by the
office behaves the same on every runtime and is read in the same places as
everything else an agent does.

## What already exists, and what the design rests on

- **A hand-over is a line with a brief.** Handing a board note to an agent
  speaks a line in the owner's DM with it — `@Marvin board note #12 Fix the
  chair is yours.` — with the note attached as an `AgentCommandCall`. The
  harness starts a turn on the line and renders the brief beside it
  (`apps/server/src/rooms/board-brief.ts`, `OfficeRoom#deliverChannelChat`,
  `packages/acp-harness/src/runner/context.ts`). A routine firing is
  delivered the same way, so the agent reports where its owner reads, and
  the DM transcript is the run log.
- **Office commands** are a word and a brief (`packages/shared/src/office-command.ts`,
  `packages/shared/src/db/commands.ts`). A routine may run one: "every
  hour, `!review` whatever is open".
- **The room already ticks.** It refreshes settings every ten seconds and
  polls GitHub for the ledger's pull requests. The scheduler is one more
  timer in the room, with a database lock so two rooms of one office never
  fire the same slot.
- **The harness has no catch-up.** A line sent to an agent that is not in
  the room is kept in `messages` but never starts a turn when it returns.
  A routine has to handle "the agent was away" itself.

## The routine

| Field | What it is |
| --- | --- |
| agent | One agent, always. The routine speaks in its owner's DM with it. |
| name | A short label, one line: "hourly PR check". |
| schedule | `cron` (five fields) with a time zone, or `once` at a time. Presets compile to cron: every N minutes/hours, daily at HH:MM, weekdays at HH:MM, weekly on a day. |
| what to do | Either instructions of its own (prompt prose, 16,000 characters like a command's), or one of the office's commands plus the arguments to give it. |
| paused | Kept but not fired. |
| created by | The owner, and the agent that made it on the owner's behalf when one did. |

**Who may make one.** Only the agent's owner — the same rule as handing it
a note, because the firing speaks as the owner. An agent may make routines
for itself and for other agents its owner owns, through tools. Admins see
every routine on the board but cannot put one on somebody else's agent.

**Floors and caps.** No cron tighter than every ten minutes. At most twenty
routines per agent.

## How a firing works

1. Every fifteen seconds the room asks the database for routines due.
2. For each, it inserts a `routine_runs` row keyed on (routine, due slot)
   and moves the routine past the slot, in one transaction. The unique
   index is the lock: whichever room's insert lands has the slot, the other
   sees the conflict and moves on. The row says `missed` until the line is
   spoken; a slot the agent is too busy for is written `skipped` and is
   done.
3. It settles the row as `fired` — the one write that may happen once, so
   two rooms making up the same slot cannot both speak — and in the same
   turn speaks `@Marvin routine "hourly PR check" is due.` in the owner's
   DM with the agent, as the owner, with a brief attached:

   ```
   [Routine hourly-pr-check — set up by Josh, runs every hour]
   It is 14:00 on Tuesday 3 March. This is what it asks each time:
   <instructions, or the command's instructions and the routine's arguments>
   Report here, in this conversation, what you did and what you found.
   ```

   The harness renders that through a small addition beside
   `commandSection`. An older harness renders it as a `[Command]` section
   and still does the work.
4. A room that stops between the claim and the line leaves a `missed`
   row, which is made up like any other; nothing is ever on the record as
   fired that the agent did not hear.

**Edge rules.**

- **The agent is away.** The run is marked missed and made up when the
  agent next joins, unless the following run is already due by then. A
  daily routine survives a closed laptop; an hourly one does not pile up.
- **The agent is still on the previous run.** Skipped and recorded, never
  queued behind it.
- **The owner leaves the office.** Its routines pause: there is nobody to
  speak as. **The agent is revoked.** Its routines go with it.
- **A personal office** fires nothing while the app is closed, like
  everything else in it. A [fleet machine](./FLEET.md) keeps firing.
- **DM only, in the first version.** A routine never speaks in a channel.

## Where routines are seen

- **Settings → Routines.** Make, edit, pause, delete; mirrors Commands.
- **Board → Routines tab.** Every routine in the office: agent, cadence, next
  due, last run and its outcome, the run history on expand, pause for yours.
- **The agent's card** in the roster: one row, "routines: 2 · next hourly PR
  check in 23m".
- **Board → Agents tab.** A "Routines · n" toggle beside History, listing
  that agent's routines and last runs. A run in progress already shows as
  the agent's working line and status.

## Tools for agents

Two families, routed through the harness's bridge to the room like the
board's, each under a scope of its own that is on by default.

- **`commands`** — `command_list`, `command_get`, `command_create`,
  `command_update`. An agent acts with its owner's rights: it may make a
  command where its owner may, and change one its owner made. Every command
  records who last wrote its words — the person answerable, and the agent
  that wrote them for that person — apart from whose command it is, so the
  brief reaches other agents headed "set up in this office by Josh, via
  Marvin", or "by Ana, changed by Josh, via Arthur" when an admin's agent
  rewrote a colleague's: an agent authoring instructions other agents will
  follow is the one new risk here, and attribution is how it is kept
  honest. Deleting stays in Settings.
- **`routines`** — `routine_list`, `routine_get`, `routine_create`,
  `routine_update` (pause and resume included), `routine_delete`. An agent
  sees and keeps the routines on its owner's agents — its own and the
  others' — and nobody else's: a routine speaks in the owner's DM, so its
  words are the owner's business. "In an hour", "every weekday at 9" and a
  raw cron line are all accepted; the phrase is resolved in `@quintal/shared`
  by the same `parseRoutineWhen` the settings form uses, in the zone the
  harness sends (its machine's). A routine is named by its name, or its id
  when two of the owner's agents share a name. The base prompt tells the
  model to use these rather than any scheduler of its own, and to pause a
  routine when asked to stop rather than agree in conversation.

## Decisions taken, open to change

- Firings are DM-only.
- Schedules are stored as cron plus an IANA time zone; next-run computation
  uses a small dependency (`croner`, no dependencies of its own, runs in
  the browser too) rather than hand-written DST rules.
- The time zone is the browser's when made in Settings, and the harness
  machine's when made by an agent (step 3) — an agent usually runs on its
  owner's computer, and no office setting is needed for it.
- No `command_delete` tool.

## Plan

Five pull requests, each shippable on its own.

- [x] **1. Commands as agent tools.** `created_by_agent_id` on
      `office_commands` and a migration; a `commands` scope; room handlers
      reusing the db functions with the owner's actor; the four tools in the
      harness and the protocol types; the "via" attribution in the brief's
      heading; prompt guidance; tests; `docs/guide/commands.md`.
- [x] **2. Routines core.** `packages/shared/src/routine.ts` (phrases to
      cron or a moment, next-due, the floor, labels); `routines` and
      `routine_runs` tables and `db/routines.ts`; the room's tick every
      fifteen seconds, the slot lock, missed slots made up, and the DM
      delivery through `#deliverChannelChat` speaking for an owner who is
      not in the room; the harness's `[Routine]` heading; audit events;
      Settings → Routines and its tab.
- [x] **3. Routine tools.** The `routine_*` tools, phrase parsing, the
      `routines` scope, base-prompt guidance.
- [ ] **4. Visibility.** Routines in the board payload; the Routines tab;
      the Agents tab toggle; the roster card row.
- [ ] **5. Docs.** `docs/guide/routines.md`, the help panel, the website
      changelog, the roadmap moved to "shipped".
