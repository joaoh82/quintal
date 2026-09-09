# The Quintal voice relay

Proximity voice between people, over the office's own server. This is the
wire format and the rules, written down because it is a public protocol: any
client that speaks it is a valid voice client, the same stance
[GATEWAY.md](./GATEWAY.md) takes for agents.

## The stance, before the bytes

- **The server decides who hears whom.** Earshot is computed in the office
  from positions, on the same tile-distance rule nearby chat uses, and a
  client is only ever sent frames from inside its set. Distance shapes
  *volume* on the client; it never widens receipt. A client bug cannot let
  you hear across the room.
- **The server never decodes.** It reads eight bytes of header to know a
  frame is a frame, prepends one byte, and forwards the rest untouched.
  There is nothing on the server that could transcribe, record, or mix.
- **Agents have no voice.** Not now, not planned. An agent never enters a
  peer set and a socket presented for an agent's session is refused at the
  door. Speaking *to* an agent will arrive later as speech-to-text on your
  side; agents answer in text, always.
- **Muted is the default, and muted means silence on the wire.** A client
  that is muted sends no frames. There is no server-side mute to get wrong.
- **Bad metadata never costs audio.** A header field the relay does not
  believe is forwarded as it came and clamped by the reader. The only reason
  a frame is dropped is that it is not the shape of a frame — or that the
  receiver cannot keep up.

## Connecting

One WebSocket per game session, at `/voice` on the office's origin — the
same origin, port and TLS as everything else, so a firewall that passes the
office passes voice. Open it only once you are in the office: the socket is
bound to the Colyseus session you hold there.

```ts
const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/voice`);
ws.binaryType = 'arraybuffer';
ws.onopen = () =>
  ws.send(JSON.stringify({ type: 'hello', token, sessionId, workspaceId }));
```

- `token` — the game session token, the one `/api/game/join` handed you.
- `sessionId` — your Colyseus session id in the office room.
- `workspaceId` — the office.

The relay checks, in this order: that a human holds that session in that
office right now, and that the token belongs to that human. Then it answers
`{ type: "welcome", sessionId }`, followed — if anybody is already within
earshot — by a `peers` message. A second socket for the same session
replaces the first, which is closed with `4409`.

### Close codes

| Code | Meaning |
| --- | --- |
| `4400` | The first message was not a hello, or was malformed. Say hello within five seconds. |
| `4401` | The token did not verify, or belongs to somebody other than that session's holder. |
| `4404` | No human holds that session in that office. Agents, strangers, and other offices land here. |
| `4408` | Three heartbeats went unanswered. |
| `4409` | A newer socket for the same session took over. |
| `4410` | The game session ended — you left, or the office closed — and the voice socket went with it. |

Heartbeat is a WebSocket ping every 30 s; the browser answers pongs on its
own. Three unanswered closes the socket.

## Control messages

Text frames, JSON, server → client. There is one client → server text
message, the hello above.

```ts
{ type: "welcome", sessionId: string }
{ type: "peers", joined: [{ sessionId, peerIndex, name }], left: [sessionId] }
{ type: "error", code: string, message: string }
```

`peers` is the map from the byte in front of a frame to the person who sent
it. It is per receiver: your index for Ann is not Bob's index for Ann. A
`joined` entry always arrives **before** the first frame from that peer, and
`left` means you will receive no more from them until they join again — at
which point they may have a different index. Indices are one byte and are
reused after a leave.

## Audio frames

Binary frames. A client sends:

```
[ seq u16 | ts_48k u32 | level_dbov i8 | flags u8 ][ opus payload ]
```

Big-endian header, eight bytes, then Opus: 48 kHz, mono, 32 kbps, VoIP mode,
DTX on, 20 ms per frame (960 samples). At most 4096 bytes in all.

- `seq` — a counter, wrapping at 65535. For jitter buffers.
- `ts_48k` — capture time in 48 kHz samples, wrapping at 2^32.
- `level_dbov` — how loud the PCM was before encoding, 0 (full scale) to
  −127 (silence). Readers clamp anything outside that range. It may drive a
  VU meter; it must not drive logic.
- `flags` — bit 0 set means a DTX frame (silence). Speaking indicators count
  frames without it.

What a receiver gets is the same bytes with one byte in front:

```
[ peer_index u8 ][ seq u16 | ts_48k u32 | level_dbov i8 | flags u8 ][ opus payload ]
```

`peer_index` is the sender's index in *your* peer table. Nothing else is
changed. A frame arrives on every socket in the sender's earshot set and on
no other.

## Earshot

Computed in the office, four times a second, from tile distance against the
office's chat radius (Settings → Office): a pair starts hearing each other
at the radius and stops two tiles past it, so standing on the line does not
flicker. Only humans are considered. A person whose connection dropped is
out of earshot until they are back. When a session ends, every pair it was
in ends with it.

Isolation at the walls of a private room is not part of this yet; when
private zones ship, the same computation gains that rule in one place.

## Limits

- Frames over 4096 bytes, or under 8, are dropped without a reply.
- A receiver whose socket is not draining loses audio, oldest first, and
  never a control message: a peer table that lags is worse than a dropped
  frame. The relay logs a receiver that is falling behind, once a minute.
- One mouth sends at most about 80 frames a second, with a burst of 100 —
  Opus at 20 ms is 50. Faster than that is a loop, not a person, and the
  excess is dropped at the sender.
- More than 25 people talking into one ear at once is a soft cap: the newest
  speaker is dropped for that receiver until somebody stops.
- One voice socket per game session. Reconnecting the game session — the
  office resumes a dropped seat for twenty seconds, then rejoins fresh —
  means reconnecting voice with the new session id and token.

## Building a client

Capture → 20 ms frames → Opus → header → socket; socket → header → per-peer
jitter buffer → Opus → per-peer gain by distance → one output. The reference
client lives in `apps/web/src/game/voice/` and uses WebCodecs
(`AudioEncoder` / `AudioDecoder` with `opus`); anything that produces the
frames above is equally welcome. *(The reference client is the next slice of
this work and is not in the repository yet; the relay is.)* Open the socket lazily — only when a
second human is within earshot — and close it when alone again: a person
alone with their agents should cost the server nothing.
