# Proposal: keypair identity, relay-style voice, desktop-first

**Status: draft, awaiting validation.** Nothing in here is scheduled. This
document exists so the three directional changes below can be judged as a
set, then folded into the private build plan as concrete steps.

The three changes, in one line each:

1. **Identity becomes a keypair.** Sign in by proving you hold a private key,
   the way Buzz does — no email, no magic link, no mail provider.
2. **Voice is an Opus relay, not LiveKit.** The server we already run forwards
   opaque audio frames between people in earshot; no SFU, no WebRTC stack,
   no second service to deploy.
3. **Desktop is the primary client.** A Tauri shell holds your keys and runs
   your fleet; the web build remains as the guest door for invited humans.

They are one direction, not three: keys want to live on a machine you own
(desktop), agents want to be spawned next to your working tree (desktop), and
voice wants the same single-process deployment story the rest of Quintal
already promises.

---

## What Buzz actually does

Findings from reading the Buzz source (`block/buzz`, Apache 2.0). Only the
mechanisms worth copying, with enough precision to implement against.

### Identity and auth

- An identity is a secp256k1 keypair, BIP-340 Schnorr signatures. Public keys
  travel as hex on the wire and bech32 (`npub…`/`nsec…`) at the human
  boundary. First launch generates a keypair; that *is* sign-up.
- **WebSocket auth (NIP-42):** on connect the server immediately sends a
  32-byte random hex challenge. The client answers with a signed event
  (kind 22242) whose tags name the relay URL and the challenge; the server
  verifies the Schnorr signature, the challenge match, the relay URL, and a
  ±60 s timestamp window. No JWT, no token store — a session is "this
  socket proved key ownership."
- **HTTP auth (NIP-98):** each request carries a base64 signed event naming
  the URL, method, and a SHA-256 of the body, with a ±60 s window and a
  server-side replay cache keyed on event id.
- **Key storage (desktop):** OS keychain first (all secrets in one JSON blob
  under a single service name, so the OS prompts once per process), a
  `0o600` `identity.key` file as fallback, an env var for CI/agents, and
  in-memory ephemeral as last resort. Migration file→keychain is crash-safe:
  write, read back, fsync a marker, only then delete the file. Backup/export
  is NIP-49 (`ncryptsec…`, scrypt-encrypted nsec) with a generated
  three-word passphrase.
- **Web client:** prefers a NIP-07 browser extension (`window.nostr`); falls
  back to an in-memory ephemeral key for people who just walked in.
- **Display names:** a profile event (kind 0) maps pubkey → display name and
  avatar; the fallback everywhere is a truncated npub (`npub1xxxx…abcd`).
- **Agent identity (NIP-OA, their own spec):** an agent gets its **own**
  keypair. The owner signs a compact attestation over
  `"nostr:agent-auth:" + agent_pubkey + ":" + conditions`, and the agent
  presents that tag inside its auth event. The server verifies the owner's
  signature, checks the owner is a member, and admits the agent as a
  *virtual* member — attributed to its owner, never merged into the owner's
  identity, revocable by revoking the owner. Agent private keys sit in the
  same keychain blob (`agent:<pubkey>`), handed to the harness process via
  env var at spawn.
- **Membership:** self-hosted servers default open; a flag turns on a members
  table. Joining is by invite code — v2 codes are 32 random bytes, stored
  hashed, with TTL and max-use caps. No email anywhere in the system.

### Voice huddles

- **Transport:** one WebSocket per participant to the relay itself
  (`/huddle/{id}/audio`), authenticated with the same NIP-42 challenge flow
  before any audio moves. No LiveKit, no WebRTC, no ICE/STUN/TURN, no SDP.
- **Wire format:** client sends `[8-byte header][Opus payload]`; the header
  is big-endian `seq:u16, ts_48k:u32, level_dbov:i8, flags:u8` (flag bit 0 =
  DTX). The server prepends a single `peer_index` byte and forwards the rest
  **verbatim** — it never decodes, mixes, or re-times audio. Per-peer send
  queues are 8 frames deep and drop-on-full: real-time audio drops, never
  queues. Control messages (join/leave rosters) ride a separate
  never-starved channel.
- **Codec:** Opus, 48 kHz mono, 32 kbps, VoIP profile, 20 ms frames, DTX on.
  ≈37 kbps up per speaker; downstream scales with speakers, not listeners
  (DTX means silent peers cost ~nothing).
- **Client side does the hard parts:** per-peer jitter buffer (NetEq,
  40–200 ms adaptive) feeding a per-peer player summed by the device mixer;
  clock drift fixed by playing 2 % fast instead of dropping buffers.
  Mute is client-side frame gating (manual + push-to-talk); the wire has no
  mute message. Speaking indicators are receive-side inference: count
  non-DTX frames per peer per 500 ms, plus the header's level byte for VU
  meters — explicitly never used for trust decisions.
- **Limits:** soft cap 25 peers per room (fan-out is N×(N−1) frame copies
  per 20 ms tick), hard cap 255 (the index byte).
- **Lifecycle is signaled, audio is not:** started/joined/left/ended are
  ordinary persisted events in the parent channel; the audio bytes
  themselves are never stored.

Two Buzz stances that transfer directly: bad client metadata must never cost
audible audio (clamp it, don't drop the frame), and the server relays but
never rewrites media.

---

## Where Quintal is today

- **Auth is Better Auth + magic link only.** `users.email` is
  `NOT NULL UNIQUE` (`packages/shared/src/db/schema.ts`); the login page is
  an email form; display names derive from the email local part; the mailer
  has a print-to-console tier for solo hosts.
- **The game door is already credential-shaped, not email-shaped.** The
  Colyseus room's `onAuth` verifies an opaque session token against the
  `sessions` table by SQL join (`apps/server/src/auth/session.ts`). Any
  login flow that mints a normal session row works without touching the
  game server.
- **Agent auth is already keypair-ish in spirit.** Agents present `qa_`
  bearer keys, hosts present `qh_` tokens, both high-entropy and hashed at
  rest, with `hostMayActAs()` enforcing same-workspace + same-owner + not
  revoked (`packages/shared/src/db/host-tokens.ts`). That predicate *is*
  NIP-OA's admission rule, minus the cryptography: today the server takes
  the DB's word for the owner↔agent binding; an attestation makes the owner
  prove it with a signature, so the binding survives outside our DB and the
  agent key never needs to be minted by the server at all.
- **Voice does not exist.** No LiveKit code, no dependency, no env vars —
  one aspirational line in `SELF_HOSTING.md` ("LiveKit configuration for
  proximity voice"). There is nothing to rip out.
- **Proximity is server-authoritative and reusable.** `#deliverChat` in
  `apps/server/src/rooms/OfficeRoom.ts` computes tile distance against
  `chatRadiusTiles` (live-reloaded from settings) and unicasts only to
  earshot; agents get a distance-annotated feed; `@`-mentions and reply-debt
  reach across the map. Voice needs exactly this loop.
- **Agents-have-no-microphone is a stated invariant**, not a gap
  (`docs/GATEWAY.md`): when voice arrives it is a human talking and an agent
  reading text via STT. Buzz's own huddle pipeline (local STT feeding the
  agent as text) validates that this is buildable.
- **Deployment promise:** one Node process, one port, one SQLite file
  (`README.md`, `SELF_HOSTING.md`). LiveKit would have been the first thing
  to break it. An in-process Opus relay keeps it.

---

## The proposal

### Workstream A — keypair identity

**A1. Pubkey column and challenge login.**
Add `users.pubkey` (unique; `email` becomes nullable) via a new migration.
Add a login endpoint pair: `GET` issues a 32-byte nonce (stored in the
existing `verifications` table with a short TTL), `POST` takes a Schnorr
signature over a canonical payload naming the server origin + nonce,
verifies with `@noble/curves/secp256k1`, and mints a standard Better Auth
session row — from there, cookies, `/api/game/join`, and the Colyseus
`onAuth` all work unchanged. Keep the magic-link plugin behind a config
flag during the transition rather than deleting it on day one.
`AuthenticatedUser.email` becomes optional; the display-name fallback
changes from `email.split('@')[0]` to a truncated npub.

**A2. Invite links replace email as the guest path.**
Buzz-style v2 codes: 32 random bytes, stored hashed, TTL + max-use caps,
minted from settings by the workspace owner. A guest opening an invite link
in the browser gets an **ephemeral keypair generated client-side** (NIP-07
extension honored when present), signs the same challenge, and walks in.
No mail provider in the loop at all; the mailer and its config become
optional and then dead. Guests are marked as such in the roster.

**A3. Agent keypairs with owner attestation.**
Agents move from `qa_` bearer secrets to their own keypairs. The desktop
app (A4/C) generates the agent key, and the owner's key signs an
NIP-OA-shaped attestation (`"quintal:agent-auth:" + agent_pubkey +
":" + conditions`). The room's `onAuth` gains a fourth credential shape:
signed challenge + attestation tag → verify both signatures → owner must be
a live member of the workspace → admit as that agent, attributed to that
owner. `hostMayActAs()`, scopes, audit, and revocation all key off
`AgentIdentity` already and survive unchanged; revocation stays soft
(revoking the binding row kicks live sessions via the existing poll).
`qa_`/`qh_` keep working until the harness migrates, then get removed —
this is a documented-protocol break for `docs/GATEWAY.md`, so it lands as
one loud, versioned change, not a drift.

**A4. Key custody.**
Desktop: OS keychain, single-blob pattern (one prompt per run), `0600` file
fallback, env var for headless agents — plus NIP-49 `ncryptsec` export with
a generated passphrase as the backup story. Browser guests: ephemeral by
design, nothing stored. Sign-out destroys local key material; "log in
elsewhere" is import-the-backup.

**Non-goal, stated deliberately:** Quintal does not become a nostr relay.
No event log rewrite, no kind numbers on chat messages, no relay
federation. We adopt the *identity and auth* layer (keypairs, npub/nsec
encodings, challenge-signing, owner attestation) because it removes email
and matches how agents already work — while the game state stays Colyseus.
Using the standard encodings keeps the door open to real nostr interop
later without committing to it now.

### Workstream B — proximity voice, relay-style

**B1. Server: an Opus relay inside the existing process.**
A `/voice` WebSocket endpoint on the same HTTP server (same origin, same
port — the reverse-proxy docs already forward WS upgrades). Handshake:
challenge → signed auth (same verifier as A1) → attach to the office room's
live state. Wire format copied from Buzz v2: 8-byte
`seq/ts_48k/level/flags` header, server prepends `peer_index`, forwards
verbatim, never decodes. Drop-on-full per-peer queues (8 frames), separate
control channel for roster updates, heartbeat with missed-pong disconnect.

**B2. Proximity is the room membership.**
This is where Quintal diverges from Buzz, on purpose. Buzz has static
huddle rooms; Quintal's "room" is **earshot**. The office server already
ticks positions, so it recomputes each player's voice-peer set from the
same tile-distance logic chat uses (`voiceRadiusTiles` joining
`chatRadiusTiles` in office settings) and pushes peer-set deltas down the
control channel. The relay then forwards your frames only to your current
earshot set — proximity enforced server-side, exactly like text chat, so a
client cannot listen from across the map. Zones become hard walls later
(same step as private-zone text). Client-side, distance shapes a per-peer
gain node so voices fade with tiles rather than gating on/off — positions
are already in the synced Colyseus state; a wrong gain value can never
widen who *receives* audio, only how loud it plays.

**B3. Agents are excluded at the peer-set boundary.**
`kind === 'agent'` never enters a voice peer set — upholding the GATEWAY.md
invariant at the same chokepoint that enforces proximity. The STT bridge
("a human talks, a nearby agent reads text") is explicitly *not* in this
workstream; it slots in later as an input feature on the existing
`NearbyChat` agent feed, which is also how Buzz feeds its agents.

**B4. Clients.**
Desktop first: capture via AudioWorklet at 48 kHz, Opus 32 kbps mono DTX,
20 ms frames; per-peer jitter buffer and per-peer playback with proximity
gain; push-to-talk as a global shortcut (a desktop-only power); mute as
client-side frame gating; speaking rings on avatars from non-DTX frame
counting. Web guests get the same pipeline in-browser (WebCodecs
`AudioEncoder` where available, wasm Opus fallback) — likely one step
behind desktop, which is acceptable: guests without audio still have text.
Soft cap ~25 concurrent speakers per earshot bubble, matching Buzz's
fan-out math; far beyond a personal office's needs.

### Workstream C — desktop-first, web for guests

**C1. Tauri 2 shell around the existing web client.**
The game client stays TypeScript/Phaser; Tauri contributes what a browser
cannot: OS keychain custody (A4), a real process runtime for agents,
global shortcuts (PTT), tray presence, and autostart. No UI rewrite.

**C2. The fleet moves into the app.**
`packages/acp-harness` becomes the engine of a managed-agent runtime inside
the desktop app (it keeps working standalone for headless/CI hosts): define
agents in the UI, keys generated and attested locally (A3), sessions
spawned as child processes with the key injected via env at spawn — the
Buzz managed-agents pattern, which is also what every serious agent-manager
app converges on. The desktop app *is* the host; the separate
`~/.quintal/host.json` token ceremony collapses into identity you already
hold.

**C3. Web narrows to the guest door.**
Browser build keeps: invite-link entry, ephemeral identity, walk, text
chat, voice reception (then full voice per B4). Operator surfaces —
fleet management, host settings, key export — move to desktop. The
positioning line: **download the app to run your office; open a link to
visit one.**

### Sequencing (proposed steps, numbers to be assigned in the plan)

Dependency-ordered; A1→A2 and C1 unblock everything else.

1. **A1** pubkey column + challenge login (magic link behind a flag)
2. **A2** invite codes + ephemeral guest identity; email path optional
3. **C1** Tauri shell with keychain custody + NIP-49 backup (**this is the
   existing desktop-app step — 0.11 — pulled earlier**, because key custody
   wants a desktop home before keys are the only identity)
4. **A3** agent keypairs + owner attestation; harness migrates off `qa_`
5. **B1+B2** voice relay + proximity peer-sets, desktop capture/playout
6. **B4** web-guest voice + polish (speaking rings, PTT, device pickers)
7. **C2/C3** managed-agent runtime in-app; web narrows to guest door
8. *(later, phase 1+)* STT bridge for agents; zone-walled voice with
   private zones; magic-link + mailer removal once flag telemetry says safe

Docs that must move in the same commits: `README.md` (magic-link onboarding
story → keypair story), `SELF_HOSTING.md` (drop the LiveKit line, add
nothing — the one-process promise now covers voice), `docs/GATEWAY.md`
(agent credential change is a versioned protocol break), landing page copy.

---

## Decision points needing validation

1. **Full nostr, or nostr-shaped auth only?** This proposal deliberately
   stops at keys/auth/attestation and does not rebuild Quintal as a relay.
   Accepting that scope is the biggest single call in this document.
2. **Guest path:** invite codes + ephemeral browser keys, with email
   removed entirely (proposed) — or keep magic link as a permanent guest
   option?
3. **Voice shape:** continuous proximity fade (proposed) vs. discrete
   huddle-style bubbles per zone? The plan assumes fade on the open floor
   and hard walls only at private zones.
4. **Desktop timing:** pulling the desktop step ahead of voice (proposed,
   because key custody and PTT want it) vs. keeping voice first on web?
5. **Attestation conditions grammar:** start with empty conditions (owner
   authorizes agent key, full stop) and add constraint clauses later —
   or carry Buzz's `kind=`/`created_at` clause grammar from day one?
   Proposed: empty now, grammar-compatible format so clauses can be added
   without re-signing ceremony changes.
