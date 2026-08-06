# Self-hosting Quintal

> **Stub.** Quintal isn't ready to host for real yet — there's no office to walk
> around in. This file exists so the shape is clear, and will grow as the pieces
> land. Containers arrive in a later step; today you run it with Node.

Quintal is deliberately boring to operate: **one Node process, one port, one
SQLite file.** No Redis, no queue, no separate web tier.

## Requirements

- Node 20.11+
- pnpm 11+
- A writable directory for the database

## Running it

```bash
git clone https://github.com/joaoh82/quintal
cd quintal
pnpm install
cp .env.example .env      # then set BETTER_AUTH_SECRET and BETTER_AUTH_URL
pnpm build
pnpm start
```

`pnpm start` runs a single process serving the web app and the game WebSocket
server on `PORT` (default 3000). Database migrations are applied on boot — there
is no migration command to run, before or after upgrades.

Minimum production configuration:

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_URL=https://office.example.com
```

Everything else has a working default. See [.env.example](./.env.example) for
the complete list.

## Email

Magic links are the only way in. Pick one:

- `RESEND_API_KEY` — send through Resend.
- `SMTP_HOST` (plus `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`) — any SMTP relay.
- Neither — the link is printed to the server console. For a single-user
  instance this is a legitimate way to run, not a fallback to feel bad about.

## Storage

`DATABASE_URL` defaults to `file:./data/quintal.db`, resolved from the repo root
(override the base with `QUINTAL_DATA_ROOT`). WAL mode is enabled on boot.

To use hosted libSQL instead, point the same variable at it — no code or schema
changes:

```bash
DATABASE_URL=libsql://your-db.turso.io
DATABASE_AUTH_TOKEN=...
```

**Backups:** stop the process (or use `sqlite3 … ".backup"`) and copy
`data/quintal.db` along with any `-wal` / `-shm` files. That file is the whole
of your instance's state.

## Behind a reverse proxy

The game connection is a WebSocket on the same origin as the app, under
`/colyseus`. Your proxy must forward upgrade requests. nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

No separate rule is needed for the game server — it's the same port.

## Health checks

`GET /health` returns:

```json
{ "rooms": 0, "clients": 0, "version": "0.0.1" }
```

`rooms` and `clients` are for this process. Point your supervisor or load
balancer at it.

## Upgrading

```bash
git pull
pnpm install
pnpm build
# restart the process
```

Migrations apply themselves on the next boot.

## Still to come

- Docker image and compose file
- LiveKit configuration for proximity voice
- Agent gateway setup (connecting your fleet)
