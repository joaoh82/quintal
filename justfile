# Quintal — task runner. `just` with no arguments lists every recipe.
# Everything here is a thin wrapper over the pnpm scripts, so contributors who
# don't have `just` installed can run `pnpm <script>` instead.

default:
    @just --list

# Install dependencies.
install:
    pnpm install

# Run web (:3000) and game server (:2567) as separate processes, with HMR.
# Sweeps up a previous run first: leftover file watchers are what turns a
# healthy dev server into one that 404s every route (see `stop`).
dev: stop
    pnpm dev

# Take a previous `just dev` down — every process, not just the ones on a port.
#
# `just dev` starts five long-lived processes and only two of them own a port.
# This recipe used to kill the port holders alone, which left the file watchers
# — `tsc --watch`, `tsx watch`, and the `concurrently` that supervises them —
# running forever, one more set per run. They're invisible: no port, no output,
# nothing in the terminal you just closed.
#
# They are not harmless. Every one of them holds macOS file-watch resources for
# the whole repo, and once enough have piled up the next `next dev` can't get
# any: Watchpack dies with `EMFILE: too many open files, watch`, Next never
# finishes indexing `apps/web/src/app`, and the route table comes up empty, so
# every route — `/login`, `/api/auth/[...all]`, all of it — answers 404 while
# `pnpm build && pnpm start` serves the same code fine. Raising the file
# descriptor limit doesn't help, because the limit was never the problem.
stop:
    #!/usr/bin/env bash
    set -uo pipefail

    # Anchored on $PWD so a second clone, or a git worktree, is left alone.
    killed=0
    for pattern in \
      "$PWD/node_modules/.*/concurrently/" \
      "$PWD/packages/shared/node_modules/.*/tsc" \
      "$PWD/apps/server/node_modules/.*/(tsx|cross-env)" \
      "$PWD/apps/web/node_modules/.*/next"
    do
      n=$(pgrep -f "$pattern" 2>/dev/null | wc -l | tr -d ' ')
      if [ "$n" -gt 0 ]; then
        pkill -f "$pattern" 2>/dev/null || true
        killed=$((killed + n))
      fi
    done

    pkill -f "acp-harness/dist/cli.js" 2>/dev/null || true
    pkill -f "demo-agent" 2>/dev/null || true

    # `next-server` renames its own process, so there's no path left to match
    # on — it, and the production server, are reachable through their ports.
    for port in 3000 2567; do
      pids=$(lsof -ti :$port 2>/dev/null || true)
      if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        echo "freed port $port"
      fi
    done

    # Anything that ignored SIGTERM gets a second, blunter pass.
    sleep 1
    for pattern in \
      "$PWD/node_modules/.*/concurrently/" \
      "$PWD/packages/shared/node_modules/.*/tsc" \
      "$PWD/apps/server/node_modules/.*/(tsx|cross-env)" \
      "$PWD/apps/web/node_modules/.*/next"
    do
      pkill -9 -f "$pattern" 2>/dev/null || true
    done

    [ "$killed" -gt 0 ] && echo "stopped $killed leftover dev process(es)"
    echo "ports clear"

# Stop anything stale, then start fresh. `just dev` does this by itself now;
# this recipe stays for the muscle memory.
restart: dev

# Build shared -> web -> server.
build:
    pnpm build

# Run the production build: one process, web + game server, one port.
start:
    pnpm start

# Typecheck every package.
typecheck:
    pnpm typecheck

# Run every test.
test:
    pnpm test

# --- agents ----------------------------------------------------------------

# Create an agent and print its key. Re-running revokes the old one.
#   KEY=$(just agent-new reviewer)
agent-new NAME:
    @pnpm -s tsx scripts/agent-new.mts {{NAME}}

# Put one scripted agent in the office. No model, no tokens, no config file.
# Needs `just dev` running in another terminal.
agent-demo:
    #!/usr/bin/env bash
    set -euo pipefail
    KEY=$(just agent-new demo)
    echo "walking 'demo' into the office — ctrl-c to stop"
    AGENT_KEY="$KEY" QUINTAL_URL=http://localhost:3000 pnpm -s demo-agent

# Boot a fleet of three scripted agents through the real ACP harness.
# Needs `just dev` running in another terminal.
fleet-demo:
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm -s --filter quintal-acp build
    DIR="${TMPDIR:-/tmp}/quintal-fleet"
    mkdir -p "$DIR"/{api,web,infra}
    FAKE="$PWD/packages/acp-harness/test/fixtures/fake-acp-agent.mjs"
    for a in reviewer builder scout; do
      export "$(echo "$a" | tr '[:lower:]' '[:upper:]')_KEY=$(just agent-new "$a")"
    done
    cat > "$DIR/quintal.fleet.json" <<JSON
    { "url": "http://localhost:3000",
      "agents": [
        { "name": "reviewer", "keyEnv": "REVIEWER_KEY", "agent": "custom", "cmd": "node $FAKE", "cwd": "./api" },
        { "name": "builder",  "keyEnv": "BUILDER_KEY",  "agent": "custom", "cmd": "node $FAKE", "cwd": "./web" },
        { "name": "scout",    "keyEnv": "SCOUT_KEY",    "agent": "custom", "cmd": "node $FAKE", "cwd": "./infra" }]}
    JSON
    export FAKE_REPLY="All 12 tests pass on the auth branch." FAKE_TOOL=Bash FAKE_DELAY_MS=3000
    node packages/acp-harness/dist/cli.js up --config "$DIR/quintal.fleet.json"

# Run the ACP harness with your own arguments. Use this rather than
# `npx quintal-acp` from inside the repo — the package isn't published yet.
#   just acp login --token qh_… --url http://localhost:3000
#   just acp up
#   just acp --key qa_… --agent claude-code --repo api
acp *ARGS:
    @pnpm -s --filter quintal-acp build
    @node packages/acp-harness/dist/cli.js {{ARGS}}

# Generate a migration from the Drizzle schema (packages/shared/src/db/schema.ts).
db-generate:
    pnpm db:generate

# Apply pending migrations by hand (the server does this on boot anyway).
db-migrate:
    pnpm db:migrate

# Create the local demo user + their personal workspace. Idempotent.
db-seed:
    pnpm db:seed

# Open Drizzle Studio against the local database.
db-studio:
    pnpm db:studio

# Wipe the local database. Destructive; local `file:` databases only.
db-reset:
    rm -rf data
    pnpm db:migrate

# Remove build output and dependencies.
clean:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf apps/web/.next apps/server/dist packages/shared/dist
