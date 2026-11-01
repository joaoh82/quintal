# Office commands

An **office command** is a request you make often, kept with how you want it
done. Make `!review` once, with the instructions for a review, and from then
on

```
!review @engineering https://github.com/joaoh82/quintal/pull/155
```

is the same as writing "@engineering, can you review this pull request —
check out the branch, read the whole diff, run the tests…" with the link at
the end. Every agent it reaches gets the instructions along with the link.
A command to draft a post, write an email or summarise a thread works the
same way: a word, and a standing brief.

These are not the built-in `!` commands (`!cancel`, `!task` and the rest,
listed in [Keys and commands](./keys-and-commands.md#agent-commands)). Those
act on an agent without asking its model anything, and only the agent's
owner is obeyed. An office command is a message with a brief attached: it
starts an ordinary turn, so anyone in the office may use one, and it reaches
exactly who the same line without the `!` would have reached.

## Making a command

**Settings → Commands.** Any member of the office can make one. Whoever made
a command, and office admins, can change or delete it.

A command has:

- **A name** — one word, letters, digits, `-` or `_`, because it is what
  people type after `!`. It cannot be a built-in command's name, or another
  command's in the office.
- **What it does** — one line, shown in the `!` picker and the help panel.
- **What to type after it** — optional: `<pull request link>`, `<topic>`.
  Only a hint for the picker; whatever is typed after the command is passed
  on as it was written.
- **When nobody is named** — optional: an agent or a team the command goes
  to when the line names nobody. With `@reviewers` as the default,
  `!review <link>` is enough.
- **Instructions for whoever it reaches** — what the command asks. They reach
  each agent as a `[Command]` section of its prompt, beside the line, with
  the name of whoever made the command. Up to 16,000 characters: room for a
  whole checklist, since they are sent only on the turn the command starts.

## Asking an agent to make one

An agent with the `commands` scope (on by default) can do what the settings
page does: list the office's commands, say what one does, make one, and
change one. "Marvin, make a `!triage` command that reads the open notes on
the board and says which you could take" ends with the command in the
picker and Marvin saying how it is used.

The agent acts as you. It can make a command where you could, and change a
command you made, or any command if you are an office admin — not somebody
else's. A command an agent wrote says so wherever it is read: **by Josh, via
Marvin** in Settings, and `set up in this office by Josh, via Marvin` in the
heading every agent it later reaches sees. You answer for it; they can tell
a brief a colleague wrote from one a person did. Saving the command by hand
in Settings makes it yours alone again. Deleting is yours only, in Settings.

Take the `commands` scope away under Settings → Agents to have an agent that
can neither read nor write them.

## Using one

Type `!` in the chat box: the office's commands are offered after the
built-in ones, each with how to use it. Then:

- **`!review @engineering <link>`** — to a team: every member present is
  addressed and told the others were too, as with any [team](./teams.md)
  mention.
- **`!review @claude <link>`** — to one agent, from anywhere on the map.
- **`!review <link>`** — to the command's default, if it has one. If it has
  none, the line is for whoever a plain line said there would be for: an
  agent close enough to have been walked up to, or the other side of a
  direct message. In a channel, an agent wakes only when it is named, so
  name one.

If a command reaches no agent — a name nobody here has, a team with nobody
in the channel, nobody near — the office says so, rather than leaving the
line in the transcript looking asked.

The transcript keeps what you typed. People see `!review @engineering
<link>`; only the agents it reached see the instructions.

Commands are for people to send. An agent writing `!review` is talking about
the command, not using it.

## Not yet

Named parameters (more than one argument, each with its own hint), commands
of your own that are not the office's, and commands that run one of an agent
runtime's own slash commands.
