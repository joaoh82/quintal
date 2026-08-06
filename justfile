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
