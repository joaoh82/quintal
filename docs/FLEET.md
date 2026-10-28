# A fleet that stays up

Agents run wherever the harness runs, and for most people that is the laptop
the desktop app is on. Close the lid and the fleet leaves the office. To keep
agents working with your computer off, run the harness on a machine that stays
on — a home server, a VPS, a spare box — as a service.

The office does not change: you still create agents in Settings → Agents and
assign them to a machine. The server never runs an agent; this machine does,
and it shows up in the list like a laptop would.

One limit up front: the machine has to reach the office. A **server** office
(one you or your team host) works from anywhere. The desktop app's **personal**
office listens only on your own computer, so a box elsewhere cannot join it.

## The short way

On Ubuntu or Debian with systemd, as root:

```bash
curl -fsSL https://raw.githubusercontent.com/joaoh82/quintal/main/scripts/provision-fleet.sh \
  | sudo bash -s -- --url https://office.example.com
```

It asks for the machine token (`qh_…`). Get one in your office at
`/settings/agents` → *Machines*: give the machine a name and press *Register
machine*; the token is shown once. Copy only the token: the command printed
with it is for a machine that already has the harness. To script it, write the token to a `0600` file
and pass `--token-file /path`, or pipe it in with `--token-file -` (the script
itself then has to come from a file rather than through `curl | bash`). It never
takes the token as an argument, where `ps` and your shell history would keep it.

What it does:

| Step | Result |
| --- | --- |
| Packages | `git`, `curl`, Node 22 (from NodeSource, if the system's is older than 20), and `gh` |
| A user | `quintal`, unprivileged, with a home directory; agents run as this user and nothing else |
| The harness | Built from the newest release tag (final releases only, never an `-rc`) into `/opt/quintal-fleet/src`, owned by root, with `/usr/local/bin/quintal-acp` pointing at it |
| Registration | `quintal-acp login --token-file -` as that user, so the token lands in `~quintal/.config/quintal/host.json`, mode `0600` |
| The service | `quintal-fleet.service`: `quintal-acp up`, `Restart=always`, started now and at boot |

The harness is built from source because `quintal-acp` is not published to npm.
It is owned by root on purpose: an agent is a model with a shell, running as
`quintal`, and it should not be able to rewrite the program that holds its
credentials.

**Updating** is the same line again. It moves to the newest release, rebuilds
if that changed anything, and restarts the fleet. The token, the user and the
runtimes you signed in to are left as they are. `--ref <tag>` pins a version.

Registering needs `quintal-acp login --token-file`, which v0.13.0 and earlier
do not have. Until a release includes it, the script builds `main` instead of
the newest tag and says so; a `--ref` older than that stops before
registering rather than leaving a fleet that cannot sign in.

```bash
systemctl status quintal-fleet       # is it up
journalctl -u quintal-fleet -f       # its log, including each agent's prefixed lines
sudo systemctl restart quintal-fleet # after installing or signing in to a runtime
```

## Signing in the runtimes

This is the step that needs you, and the one people get stuck on, because
every runtime wants a browser for its usual sign-in. Do it as the agents' user:

```bash
sudo -iu quintal
```

Then, per runtime you assign to this machine. Install them as this user, not
system-wide, so the service finds them on its `PATH` (`~/.local/bin` comes
first); for npm packages run `npm config set prefix ~/.local` once.

| Runtime | Install | Sign in without a browser on this box |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | Run `claude setup-token` on a computer that has a browser, then put `CLAUDE_CODE_OAUTH_TOKEN=…` in `/etc/quintal-fleet.env`. Or an `ANTHROPIC_API_KEY` there. |
| Codex | `npm install -g @openai/codex` | `codex login --device-auth` prints a code to enter on any device. Or an `OPENAI_API_KEY`. |
| Goose | [its install script](https://block.github.io/goose/docs/getting-started/installation) | `goose configure` is a terminal dialog; choose a provider and give it an API key. |
| Gemini CLI | `npm install -g @google/gemini-cli` | A `GEMINI_API_KEY` in the env file. |
| opencode | `npm install -g opencode-ai` | `opencode auth login`, which takes an API key in the terminal. |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | A `CURSOR_API_KEY` in the env file. |

`/etc/quintal-fleet.env` is root-owned, `0600`, and loaded by the service.
Quintal's own credentials are stripped from the environment a runtime gets
(see [Keys never reach the runtime](../packages/acp-harness/README.md#keys-never-reach-the-runtime));
these runtime keys are not, which is what they are there for.

After signing in, restart the service. The office learns which runtimes this
machine has when the fleet boots, so the settings page only offers what is
really installed here. Adapters (Claude Code's and Codex's ACP bridges) are
fetched by `npx` on first use and need nothing from you.

## Repositories and pushing

Agents work in the nest, `~quintal/.quintal`, and reach the checkouts through
its `REPOS/` link: `~quintal/projects` unless you passed `--repos-dir`. Clone
what they should work on there, as `quintal`, so the files are theirs:

```bash
sudo -iu quintal
git clone https://github.com/you/api.git ~/projects/api
```

Each task gets its own branch and worktree cut from those checkouts (see
[A worktree per task](../packages/acp-harness/README.md#a-worktree-per-task)),
so pushing is the one credential agents need. The simple version is
`gh auth login` as `quintal` with a fine-grained token limited to those
repositories; `gh auth setup-git` then makes `git push` use it, and `gh` is
also how the harness notices a task's pull request. Whatever you give this
user, every agent on the machine can use: give it what you would give a
contractor working on those repos, and no more.

## Doing it by hand

On another distribution, or to see each step: install Node 20 or newer and
git; make an unprivileged user; build the harness from a checkout of a release
tag (`pnpm install --frozen-lockfile --filter quintal-acp...`, then build
`@quintal/shared` and `quintal-acp`); run
`quintal-acp login --token-file <file> --url <office>` as that user; and give
your init system `quintal-acp up` to keep running, as that user, restarted
when it exits. The unit the script writes is a fair template:

```ini
[Service]
User=quintal
WorkingDirectory=/opt/quintal-fleet
Environment=HOME=/home/quintal
Environment=PATH=/home/quintal/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-/etc/quintal-fleet.env
ExecStart=/usr/local/bin/quintal-acp up --url https://office.example.com
Restart=always
RestartSec=5
```

`up` stops its agents on `SIGTERM`, so `systemctl stop` brings them home
cleanly. The working directory is root-owned on purpose: `up` prefers a
fleet file there (`quintal.fleet.json` or `.quintal/fleet.json`) to what the
office assigns, and the agents' home directory, nest included, is somewhere
they can write. Running `up` from home would let an agent decide what the
fleet runs at the next restart. For the same reason the wrapper names `node`
by absolute path rather than searching a `PATH` that starts with
`~/.local/bin`.
