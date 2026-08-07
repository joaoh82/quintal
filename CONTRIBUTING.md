# Contributing to Quintal

Thanks for being here. Quintal is built in public and early enough that most
things are still up for discussion — opening an issue to argue about a design
decision is as useful as a PR.

## Ground rules

- **Every commit needs a DCO sign-off.** See below. A GitHub Action enforces it.
- **Talk before you build something big.** For anything beyond a bug fix, open
  an issue first so we don't both write the same thing differently.
- **Assume every file is world-readable.** Never commit secrets, tokens, real
  email addresses or a `.env`. The `data/` directory and all `.env*` files are
  git-ignored — keep it that way.

## Developer Certificate of Origin (DCO)

Quintal uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. You keep your copyright; you're certifying that you have the
right to submit the code under the project's license.

Sign off every commit:

```bash
git commit -s -m "office: add proximity radius constant"
```

That appends a trailer to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must match the commit author. Forgot on the last commit?

```bash
git commit --amend -s --no-edit
```

For a whole branch:

```bash
git rebase --signoff main
```

## Getting set up

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Web on <http://localhost:3000>, game server on :2567. Without an email provider
configured, magic-link sign-in prints the link to the server console.

Before pushing:

```bash
pnpm typecheck
pnpm build
```

## Project layout

| Path | What lives there |
| --- | --- |
| `apps/web` | Next.js app: pages, auth config, UI components, the Phaser game |
| `apps/server` | Production entry point: Colyseus rooms, HTTP routing, Next.js hosting |
| `packages/shared` | Types + constants both apps import, the map and its parser, pathfinding, Drizzle schema and migrations |
| `tools/` | One-shot scripts, not part of any build |

Anything both the browser and the server need goes in `packages/shared`. The
root export must stay client-safe (no `node:*` imports) — server-only pieces
live under `@quintal/shared/db`.

## Database changes

1. Edit `packages/shared/src/db/schema.ts`.
2. Run `pnpm db:generate` and commit the generated SQL in
   `packages/shared/drizzle/`.
3. Don't write a migration command into any setup instructions: the server
   applies pending migrations on boot, and self-hosters should never have to
   think about it.

Keep the schema portable across local SQLite and remote libSQL (Turso). No
Postgres-specific types.

If you change the auth configuration, you can compare our hand-maintained auth
tables against what Better Auth expects with
`npx @better-auth/cli generate --config src/lib/auth.ts` from `apps/web`. The
CLI can't load a config that imports `server-only`, so comment that import out
while you run it, then put it back.

## The map

`packages/shared/maps/hq.json` is a standard Tiled map — open it in
[Tiled](https://www.mapeditor.org/) and edit it. It lives in `shared` because
the game server will read the same file, so the walkability grid the client
walks on is the one the server simulates.

Layer contract, enforced by the parser in `packages/shared/src/game/tiled.ts`:

| Layer | Type | Collides |
| --- | --- | --- |
| `floor` | tiles | no |
| `walls` | tiles | **yes** |
| `furniture` | tiles | **yes** |
| `decor` | tiles | no |
| `spawns` | objects (points) | — |
| `zones` | objects (rectangles) | — |

Every zone rectangle needs `kind` (`private`, `spawn` or `agent_area`), `zoneId`
and `label` properties; the parser throws on an unknown `kind` rather than
silently dropping the zone. A door is simply a hole in the `walls` layer.

`tools/generate-hq-map.mjs` is how the map was first built. It is **not** a build
step — if you've edited the map in Tiled, re-running it will overwrite your work.

Art comes from Kenney's CC0 packs. If you add assets, record where they came from
and their license in `apps/web/public/assets/CREDITS.md`.

## Conventions

- TypeScript strict everywhere; no `any` in new code without a comment saying why.
- Comments explain *why*, not *what*. Match the density of the surrounding file.
- Agents are first-class: anything modelling a person in the office must handle
  `kind: "human" | "agent"`, not humans with agents bolted on.
- Solo-first: no feature may require a second human to be useful.

## Reporting bugs

Include what you ran, what you expected, what happened, and your Node and pnpm
versions. If it involves the database, say whether you're on local SQLite or
remote libSQL.
