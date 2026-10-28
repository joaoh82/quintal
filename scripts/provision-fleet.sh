#!/usr/bin/env bash
# A fleet that stays up: run quintal-acp as a service on a headless machine.
#
#   sudo ./provision-fleet.sh --url https://office.example.com --token-file /root/qh.token
#   curl -fsSL https://raw.githubusercontent.com/joaoh82/quintal/main/scripts/provision-fleet.sh \
#     | sudo bash -s -- --url https://office.example.com
#
# Ubuntu or Debian with systemd. It makes an unprivileged user to run agents
# as, installs Node and git, builds the harness from the latest release tag
# into /opt/quintal-fleet, registers the machine with the office, and runs
# `quintal-acp up` under a systemd unit that restarts it. Running it again
# updates the harness to the newest release and restarts the fleet; the
# token, the user and their runtimes are left alone.
#
# The machine token never goes on a command line, where `ps` and shell
# history would keep it: give it as a 0600 file (--token-file), or on stdin
# (--token-file -), or type it at the prompt. See docs/FLEET.md.
set -euo pipefail

REPO_URL="https://github.com/joaoh82/quintal.git"
PREFIX="/opt/quintal-fleet"
SERVICE="quintal-fleet"
NODE_MAJOR=22
PNPM="pnpm@11.0.9"

user="quintal"
url=""
token_file=""
ref=""
host_label=""
repos_dir=""

usage() {
  cat <<'EOF'
Usage: sudo provision-fleet.sh [options]

  --url <url>           the office this machine joins (required the first time)
  --token-file <path>   the machine token (qh_…) from Settings → Agents, as a
                        file; - reads it from stdin. Without one, the script
                        prompts on the terminal if this machine has no token.
  --user <name>         the account agents run as (default: quintal)
  --host <label>        the name this machine shows in the office
  --repos-dir <dir>     where the agents' checkouts live (default: ~/projects
                        of that user)
  --ref <tag|branch>    build this ref instead of the latest release tag
  -h, --help            this text
EOF
}

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf 'provision-fleet: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) url="${2:?--url needs a value}"; shift 2 ;;
    --token-file) token_file="${2:?--token-file needs a path or -}"; shift 2 ;;
    --user) user="${2:?--user needs a value}"; shift 2 ;;
    --host) host_label="${2:?--host needs a value}"; shift 2 ;;
    --repos-dir) repos_dir="${2:?--repos-dir needs a value}"; shift 2 ;;
    --ref) ref="${2:?--ref needs a value}"; shift 2 ;;
    --token) die "--token would put the credential in ps and your shell history; use --token-file <path> or --token-file -" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root (sudo): it creates a user and a systemd unit"
command -v systemctl >/dev/null || die "this needs systemd"
command -v apt-get >/dev/null || die "this script knows Debian and Ubuntu (apt-get); see docs/FLEET.md to do it by hand"

# Read a piped token now, before anything else touches stdin.
token=""
if [ "$token_file" = "-" ]; then
  token="$(cat)"
elif [ -n "$token_file" ]; then
  [ -r "$token_file" ] || die "cannot read $token_file"
  token="$(cat "$token_file")"
fi
token="$(printf '%s' "$token" | tr -d '[:space:]')"
if [ -n "$token" ] && [ "${token#qh_}" = "$token" ]; then
  die "a machine token starts with qh_ — get one at /settings/agents in your office"
fi

# --- packages ----------------------------------------------------------------

say "Installing git, curl and Node $NODE_MAJOR"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg >/dev/null
have_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [ -z "$have_major" ] || [ "$have_major" -lt 20 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
# gh is how agents open pull requests; Debian and Ubuntu both package it.
apt-get install -y -qq gh >/dev/null 2>&1 || say "gh is not in this release's archive; install it by hand for pull requests (https://cli.github.com)"

# --- the user agents run as ----------------------------------------------------

if ! id "$user" >/dev/null 2>&1; then
  say "Creating user $user"
  useradd --create-home --shell /bin/bash "$user"
fi
home="$(getent passwd "$user" | cut -d: -f6)"
[ -n "$home" ] && [ -d "$home" ] || die "user $user has no home directory"
as_user() { runuser -u "$user" -- env HOME="$home" PATH="$home/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }
as_user mkdir -p "$home/projects" "$home/.local/bin"

# --- the harness ----------------------------------------------------------------
#
# Built from source, not npm: quintal-acp is not published there. Owned by
# root, so an agent (a model with a shell, running as $user) cannot rewrite
# the program that holds its credentials.

src="$PREFIX/src"
if [ ! -d "$src/.git" ]; then
  say "Cloning Quintal into $src"
  install -d -m 0755 "$PREFIX"
  git clone --quiet "$REPO_URL" "$src"
fi
git -C "$src" fetch --quiet --tags --force origin
if [ -z "$ref" ]; then
  # Final releases only: version sort ranks v0.1.2-rc.1 above v0.1.2, and a
  # machine that took the rc would stay on it after the release.
  ref="$(git -C "$src" tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  [ -n "$ref" ] || die "no release tags in $REPO_URL"
  # Registration needs `login --token-file`. Until a release has it, build
  # main rather than a harness this script cannot register with.
  if ! git -C "$src" grep -q -e '--token-file' "$ref" -- packages/acp-harness/src/cli.ts; then
    say "$ref predates login --token-file; building main until a release has it"
    ref="main"
  fi
fi
# A branch is taken from origin each time, detached: a local branch would stay
# where the first run left it and never update.
git -C "$src" checkout --quiet --force --detach "origin/$ref" 2>/dev/null \
  || git -C "$src" checkout --quiet --force --detach "$ref" \
  || die "no such ref: $ref"
head="$(git -C "$src" rev-parse HEAD)"

# The commit the CLI on disk was built from, written only after a build
# succeeds. HEAD alone is not that: a failed build leaves HEAD moved and the
# old dist/ in place, and the next run would call it current.
cli="$src/packages/acp-harness/dist/cli.js"
stamp="$PREFIX/built-commit"
if [ ! -f "$cli" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$head" ]; then
  say "Building quintal-acp at $ref"
  rm -f "$stamp"
  (
    cd "$src"
    npx -y "$PNPM" install --frozen-lockfile --filter quintal-acp... >/dev/null
    npx -y "$PNPM" --filter @quintal/shared build >/dev/null
    npx -y "$PNPM" --filter quintal-acp build >/dev/null
  )
  [ -f "$cli" ] || die "the build did not produce $cli"
  printf '%s\n' "$head" > "$stamp"
else
  say "quintal-acp is already at $ref"
fi

# The node chosen now, by absolute path. `env node` would search PATH, and
# the unit puts the agent user's writable ~/.local/bin first: a `node` there
# would run in place of this root-owned harness.
node_bin="$(command -v node)" || die "node is not installed"
cat > /usr/local/bin/quintal-acp <<EOF
#!/bin/sh
exec $node_bin "$cli" "\$@"
EOF
chmod 0755 /usr/local/bin/quintal-acp

# --- the machine token ------------------------------------------------------------

config_dir="$home/.config/quintal"
if [ -z "$token" ] && [ ! -s "$config_dir/host.json" ]; then
  [ -n "$url" ] || die "first run: --url <office> is required"
  if [ -r /dev/tty ]; then
    printf 'Machine token (qh_…, from %s/settings/agents): ' "$url" > /dev/tty
    IFS= read -rs token < /dev/tty
    printf '\n' > /dev/tty
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
  fi
  [ -n "$token" ] || die "no machine token: pass --token-file <path> or --token-file -"
fi

quintal-acp --help 2>/dev/null | grep -q -e '--token-file' \
  || die "the harness at $ref has no login --token-file, which registering needs; use a newer --ref"

if [ -n "$token" ]; then
  [ -n "$url" ] || die "--url is required with a token: a token belongs to one office"
  say "Registering this machine with $url"
  login=(login --token-file - --url "$url")
  [ -n "$host_label" ] && login+=(--host "$host_label")
  [ -n "$repos_dir" ] && login+=(--repos-dir "$repos_dir")
  printf '%s\n' "$token" | as_user quintal-acp "${login[@]}"
fi
token=""

# --- the service --------------------------------------------------------------------

env_file="/etc/$SERVICE.env"
if [ ! -f "$env_file" ]; then
  # Runtime credentials that sign in by environment variable go here, e.g.
  # ANTHROPIC_API_KEY or OPENAI_API_KEY. The harness passes the runtime its
  # environment minus Quintal's own credentials, so these do reach it.
  install -m 0600 /dev/null "$env_file"
  printf '# Environment for %s, e.g. ANTHROPIC_API_KEY=… (see docs/FLEET.md)\n' "$SERVICE" > "$env_file"
fi

unit="/etc/systemd/system/$SERVICE.service"
# WorkingDirectory is not the home directory: `up` prefers a fleet file in its
# working directory (quintal.fleet.json, .quintal/fleet.json) over the office,
# and the agents can write anywhere under home. $PREFIX is root-owned, so
# nobody running as $user can plant one there.
up=(up)
[ -n "$url" ] && up+=(--url "$url")
# A re-run without --url keeps the unit it wrote before, and the office in it.
if [ -n "$url" ] || [ ! -f "$unit" ]; then
cat > "$unit" <<EOF
[Unit]
Description=Quintal agent fleet (quintal-acp up)
Wants=network-online.target
After=network-online.target

[Service]
User=$user
WorkingDirectory=$PREFIX
Environment=HOME=$home
Environment=PATH=$home/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-$env_file
ExecStart=/usr/local/bin/quintal-acp ${up[*]}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
say "The fleet is running: systemctl status $SERVICE · journalctl -u $SERVICE -f"

# --- what is still yours to do ---------------------------------------------------------

missing=()
for bin in claude codex goose gemini opencode cursor-agent; do
  as_user sh -c "command -v $bin" >/dev/null 2>&1 || missing+=("$bin")
done
cat <<EOF

Next, as $user (sudo -iu $user):
  • install and sign in to the runtimes your agents use — docs/FLEET.md has
    the headless steps for each. Not found on PATH yet: ${missing[*]:-none}
  • gh auth login, so agents can push and open pull requests
  • clone the repositories agents work on into ${repos_dir:-$home/projects}
Then assign agents to this machine at ${url:-your office}/settings/agents.
After installing a runtime, restart the fleet so the office sees it:
  sudo systemctl restart $SERVICE
Run this script again to update to the newest release.
EOF
