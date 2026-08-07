# Quintal — task runner. `just` with no arguments lists every recipe.
# Everything here is a thin wrapper over the pnpm scripts, so contributors who
# don't have `just` installed can run `pnpm <script>` instead.

default:
    @just --list

# Install dependencies.
install:
    pnpm install

# Run web (:3000) and game server (:2567) as separate processes, with HMR.
dev:
    pnpm dev

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

# Run the ACP harness with your own arguments.
#   just acp up
#   just acp --key qa_… --agent claude-code --cwd ~/projects/api
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
