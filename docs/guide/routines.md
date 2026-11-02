# Routines

A **routine** is a standing request to one of your agents, on a schedule.
"Every hour, review the open pull requests." "Weekdays at nine, look at the
board and say what you could pick up." "In an hour, check that the deploy
went out." Anything an agent can be asked once, it can be asked on a
schedule — and the office keeps the schedule, not the agent's runtime, so a
routine works the same on Claude Code, Codex, Goose or anything else, and is
read in the same places as everything else an agent does.

## How a routine fires

When a routine is due, a line from you appears in your DM with the agent —
`@Marvin routine "hourly PR check" is due.` — with the routine's brief
attached, the way a note handed over from the board is. The agent reads it
as you asking, does the work, and reports in that DM. The DM is the run log:
every firing and every answer is there to read back.

A routine fires while the agent is in the office. If it was away for a slot,
the slot is **missed** and made up when the agent comes back — unless the
next slot has come by then, in which case that one fires and the missed one
is history. A daily routine survives a closed laptop; an hourly one does not
pile up. A slot that comes while the agent is still on the previous run is
**skipped**, never queued behind it.

A personal office fires nothing while the app is closed, like everything
else in it. A [fleet machine](../FLEET.md) keeps firing.

## Making one

**Settings → Routines.** Only an agent's owner puts a routine on it, because
the firing speaks as you. A routine has:

- **An agent** — one of yours.
- **A name** — one line: "hourly PR check".
- **When** — in words: `every hour`, `every 15 minutes`, `every 2 hours`,
  `daily at 9`, `weekdays at 17:30`, `every monday and thursday at 9`,
  `every weekend at noon`; once: `in 45 minutes`, `tomorrow at 9`,
  `on friday at 4pm`; or a five-field cron line. Nothing tighter than every
  ten minutes: a firing is a whole turn. The time is in your browser's time
  zone, and the routine keeps it across daylight-saving changes — "daily at
  9" is nine o'clock all year.
- **What to do** — instructions of its own, up to 16,000 characters, or one
  of the office's [commands](./commands.md) plus the arguments to give it:
  "every hour, `!review` whatever is open".

**Pause** keeps a routine without firing it; **Resume** counts from now.
At most twenty routines per agent.

## Asking an agent to make one

An agent with the `routines` scope (on by default) keeps routines the way
the settings page does: list them, say what one does, make one, change one,
pause it, delete it. "Marvin, every weekday at nine, look at the board and
tell me what you could pick up" ends with a routine on Marvin, and Marvin
saying when it first fires. "Stop the morning check" pauses it. An agent
may keep routines on itself and on your other agents, and on nobody else's.

A routine an agent made says so wherever it is read — **by Josh, via
Marvin** — and the brief the agent later receives says the same, so it can
tell a request a colleague wrote from one a person did.

Take the `routines` scope away under Settings → Agents to have an agent
that can neither read nor keep them.

## Where routines are seen

- **Settings → Routines.** Every routine in the office, with its words; edit,
  pause and delete your own.
- **Board → Routines.** Every routine, on whichever agent: whether the
  agent is here to hear it, how often it runs, when it is next due — or
  that it fires when the agent is back — and what came of its last slot,
  with the recent runs on **Runs**. **Pause** and **Resume** for yours.
- **Board → Agents.** **Routines · n** on an agent's row lists its routines
  and their last runs.
- **The agent's card** in the roster: one line, `routines: 2 · next hourly
  PR check in 23m`.
- **The agent's audit log** under Settings → Agents records every firing,
  miss and skip, and every routine an agent made or changed.

## Not yet

Routines that speak in a channel rather than your DM, and a routine on a
team.
