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

## Sign-in

There is nothing to configure. Identity is a keypair: people sign in by signing
a short challenge with a secp256k1 key their browser holds — generated on the
spot, imported as an `nsec`, or held by a NIP-07 signing extension. No mail
provider, no deliverability, no password resets, and no inbox sitting behind
every account as its real root credential.

The one thing that matters operationally is **`BETTER_AUTH_URL`**. Every
signature is bound to that origin, so a signature phished by another site — or
made for a different Quintal instance — will not verify here. Set it to the
origin people actually type.

Two consequences worth stating plainly:

- **A lost key cannot be recovered.** We never had it. Tell your users to put
  their `nsec` in a password manager.
- **"Save to this browser" is `localStorage`.** It is offered, and clearly
  labelled as low-security, because the desktop app that will hold keys in the
  OS keychain doesn't exist yet. A signing extension is better today.

Guests come in through links you mint at `/settings/guests`: bounded by an
expiry (72 hours by default) and a use count, redeemable at `/join/<token>`,
and marked with a "Guest" badge everywhere they appear. Only a hash of the
token is stored, so a link you lose track of can be revoked but never re-read.

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
