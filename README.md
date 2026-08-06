# Quintal

**A spatial office where your AI agents are visible teammates.** Quintal is a 2D
office — a tile map you walk around as an avatar, in the spirit of Gather.town —
built for a primary user who is one developer plus their fleet of AI agents.
Agents aren't a sidebar or a log tail: they get avatars, desks, status and
presence, so a glance at the room tells you what your fleet is doing. Other
humans can be invited in, but nothing assumes a team.

> **Under construction.** This is early, and honest about it: today you can sign
> in and walk a single avatar around a 2D office — tile map, collision,
> click-to-move pathfinding, zones. Nobody else can see you yet: there is no
> networking, no voice and no agent gateway. Building in public means you can
> watch that happen — every file here is world-readable and written with that in
> mind.

## Quickstart

Requires Node 20.11+ and [pnpm](https://pnpm.io) 11+.

```bash
pnpm install
cp .env.example .env   # optional — the defaults work as-is
pnpm dev
```

Then open <http://localhost:3000>. Sign in with any email: without an email
provider configured, the magic link is **printed to the server console** — that
is a supported way to run a solo instance, not just a dev hack.

You land in the office at `/office`. **WASD or arrow keys** to walk, **click**
to route there with pathfinding, **Z** to show the zone and collision overlay.

The database is created for you at `data/quintal.db` and migrations run on boot.
There is no setup command to forget.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Web on :3000 + game server on :2567, two processes, fast HMR |
| `pnpm build` | Build shared → web → server |
| `pnpm start` | **One** process serving web + game server on one port |
| `pnpm typecheck` | Typecheck every package |
| `pnpm db:generate` | Generate a migration after changing the schema |
| `pnpm db:seed` | Create a local demo user + personal workspace (idempotent) |

There's a [`justfile`](./justfile) with the same recipes (`just dev`, `just
db-generate`, …) if you prefer `just`.

## Architecture

Quintal deploys as **one service**. In production a single Node process serves
both the Next.js app and the Colyseus WebSocket server from the same HTTP server
and port — same origin, no CORS, one thing to deploy and one thing to restart.
In development they split into two processes so Next keeps its fast refresh.

```
                    ┌──────────────── production: ONE process ────────────────┐
                    │                                                         │
  browser ──────────┤  apps/server (entry point)                              │
   :3000            │    ├─ http.Server ──┬─ /health          -> JSON status  │
                    │    │                ├─ /colyseus/*      -> Colyseus     │
                    │    │                └─ everything else  -> Next.js      │
                    │    ├─ Colyseus 0.16 (WebSocketTransport, OfficeRoom)    │
                    │    └─ next({ dir: '../web' }) prepared in-process       │
                    └─────────────────────────────────────────────────────────┘

  development: next dev :3000  ──rewrite /colyseus/*──>  apps/server :2567
```

The `/colyseus` prefix is identical in both modes, so client code always points
at `${origin}/colyseus` — in dev `next dev` proxies it (including the WebSocket
upgrade), in production `apps/server` strips the prefix and hands the request to
Colyseus.

```
apps/
  web/        Next.js 15 App Router, TypeScript strict, Tailwind v4 + shadcn/ui.
              Pages: / (landing), /login (magic link), /office (protected, hosts
              the Phaser canvas). Not deployed on its own — the server serves it.
  server/     The production entry point. Boots Colyseus, applies database
              migrations, and in production initialises Next.js in-process.
packages/
  shared/     Types + constants both apps import (PlayerState with
              kind: "human" | "agent", map zones, WS message enums), the Tiled
              map + its parser, A* pathfinding, the game/UI event bridge, and
              the Drizzle schema, migrations and database client.
tools/        One-shot scripts, e.g. the generator that bootstrapped the map.
```

**Storage** is SQLite through Drizzle ORM and the libSQL client, in WAL mode.
`DATABASE_URL` defaults to `file:./data/quintal.db`; the same variable takes a
`libsql://` URL (e.g. Turso) with no code changes — no Postgres-only types are
used anywhere. Pending migrations are applied automatically on boot, so
self-hosters never run a migration command.

**The world** is a [Tiled](https://www.mapeditor.org/) map at
`packages/shared/maps/hq.json` — three meeting rooms, an open floor, and a large
central Agent Bay — rendered with [Phaser 3](https://phaser.io). The map lives in
`packages/shared` rather than in the web app because the game server will read
the same file: the walkability grid the client's pathfinder uses is the one the
server will simulate against, not a second opinion. Game state stays inside
Phaser and reaches React through a typed event bridge, so a 60fps loop never
touches the reconciler.

Art is [Kenney's](https://kenney.nl) CC0 RPG Urban Pack — see
[apps/web/public/assets/CREDITS.md](./apps/web/public/assets/CREDITS.md).

**Auth** is [Better Auth](https://better-auth.com) with email magic links and
sessions in the database. Onboarding is solo-first: on first sign-in you get a
personal workspace (`"<name>'s Office"`) with you as owner. There is no
team-setup screen anywhere.

See [SELF_HOSTING.md](./SELF_HOSTING.md) for deployment, and
[.env.example](./.env.example) for every environment variable.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). All
commits need a DCO `Signed-off-by` line (`git commit -s`); a GitHub Action
enforces it.

## License

[AGPL-3.0](./LICENSE). If you're wondering why AGPL and what it means for you as
a self-hoster — short version: everything is free, forever — read
[LICENSE-FAQ.md](./LICENSE-FAQ.md).
