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

## Naming your instance

Settings → Office → **This server**. It is shown on the sign-in page and the
landing page, before anybody has an account, so somebody arriving at your URL
recognises the place rather than reading a hostname.

Left empty, the address is shown instead — which is also always shown alongside
the name, because two deployments can be called the same thing and "am I on
staging or production" is worth being able to answer at a glance.

Only an instance admin can change it, along with the other instance-wide
settings. The first account to sign in on a fresh instance becomes one, because
somebody has to be able to name the place.

After that it is granted deliberately, from a shell on the machine:

```bash
pnpm admin                 # who is in charge
pnpm admin grant  npub1…   # add somebody
pnpm admin revoke npub1…   # remove somebody
```

They have to have signed in at least once — an account appears when somebody
arrives with a key, and inventing one from a shell would put a person in the
office who has never been to it.

There is no admin panel and this is not one. It is the smaller thing underneath:
a way to say who may touch instance-wide settings, correctable from outside the
app. That matters because "the first account" is often not the person running
things — on any instance that has seen testing, the earliest key may be one
nobody uses.

## Running two offices on one machine

Only in development, and only because it is the honest way to test that two
offices are separate. Both dev ports move, and the sign-in origin follows the
web port on its own:

```bash
QUINTAL_WEB_PORT=3100 QUINTAL_GAME_PORT=2667 \
  DATABASE_URL=file:./data/second.db pnpm dev
```

Give the second one its own database, or it is one office wearing two
addresses — same people, same agents, and nothing proved.

Point the desktop app at `http://localhost:3100`. **Not** `127.0.0.1:3100`:
that is the same server reached by a different origin, and sign-in is bound to
the one the office was configured with, so it will be refused.

## The desktop app

The app is a client, not a second server. It loads whatever office you point it
at — `http://localhost:3000`, your deployment, or somebody else's — so a
self-hosted instance needs nothing extra to support it.

The office URL is stored per machine and defaults to localhost; the app grants
IPC to that one origin and no other, so pointing it somewhere new is a
deliberate act rather than a redirect.

Everything social works in a plain browser tab against the same instance. What
the app adds is key custody and the ability to run agents on the computer it is
installed on — see [docs/DESKTOP.md](./docs/DESKTOP.md).

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

## Deploying on Railway

One service. The app, the game server and the migrations are a single process,
so there is nothing to split apart.

```bash
DATABASE_URL=libsql://your-db.turso.io
DATABASE_AUTH_TOKEN=...
BETTER_AUTH_SECRET=...        # openssl rand -base64 32
BETTER_AUTH_URL=https://office.example.com
```

Create the database first — `turso db create quintal`, then `turso db show
--url` and `turso db tokens create` for the two values above. The free tier is
enough to run a small instance at no cost.

**Prefer Turso to a Railway Volume.** A volume can only be mounted by one active
deployment, so Railway cannot overlap the old and new versions: every push
becomes stop-then-start and everyone in the office is disconnected. Nothing is
lost when that happens — positions live in memory and chat is stored nowhere —
but it is a tax on every deploy, and a volume has no backup story of its own.
Turso removes the volume while keeping the same SQLite dialect, the same
schema and the same migrations, and brings point-in-time recovery with it.

> **Leave the replica count at one.**
>
> Colyseus rooms live in the memory of the process that created them. A second
> instance is a second office that cannot see the first: two people who both
> "join the office" can land in different rooms and never meet, and an agent
> can be connected to one while its owner is in the other.
>
> Running more than one node needs shared presence and a matchmaker that routes
> a join to the node already holding that room — `@colyseus/redis-driver` and
> the work around it — not a bigger number. Worth knowing that a volume made
> this mistake impossible by refusing to mount twice. Turso does not, so the
> guardrail is now this paragraph.

Avatars and file attachments will need object storage; that is not wired up
yet — see [Still to come](#still-to-come).

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

- Object storage for avatars and file attachments — a local directory by
  default, any S3-compatible bucket (Railway, R2, MinIO) in the cloud
- Docker image and compose file
- LiveKit configuration for proximity voice
- Agent gateway setup (connecting your fleet)
