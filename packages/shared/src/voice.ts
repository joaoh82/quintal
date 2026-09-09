/**
 * Proximity voice, the parts both ends agree on.
 *
 * The office relays Opus frames between people who can hear each other and
 * never looks inside one. What it does look at is here: the eight-byte header
 * a client puts in front of every frame, the control messages that tell a
 * client who it is hearing, the close codes, and the rule that decides who
 * hears whom — computed on the server from tile distance, with hysteresis so
 * standing on the boundary does not flap.
 *
 * Nothing here may import `node:*`: the browser packs headers and reads
 * control messages with the same code. The wire format is public and
 * documented in `docs/VOICE.md`.
 */

export const VOICE_PATH = '/voice';

// --- frames -----------------------------------------------------------------

/** Opus, 48 kHz, mono, 20 ms — the constants the whole pipeline assumes. */
export const VOICE_SAMPLE_RATE = 48_000;
export const VOICE_FRAME_MS = 20;
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000;
export const VOICE_BITRATE = 32_000;

/** `seq u16 | ts_48k u32 | level_dbov i8 | flags u8`, big-endian. */
export const VOICE_HEADER_BYTES = 8;
/** Header plus the largest Opus payload we accept. Anything bigger is refused. */
export const VOICE_FRAME_MAX_BYTES = 4096;
/** The relay prepends one byte: the sender's index in the receiver's peer table. */
export const VOICE_PEER_INDEX_BYTES = 1;

/** `flags` bit 0: a DTX (silence) frame. Speaking rings count frames without it. */
export const VOICE_FLAG_DTX = 1;

/** How loud, in dBov: 0 is full scale, -127 is silence. Anything else is clamped. */
export const VOICE_LEVEL_MIN = -127;
export const VOICE_LEVEL_MAX = 0;

export interface VoiceFrameHeader {
  seq: number;
  /** Capture time in 48 kHz samples, wrapping at 2^32. */
  timestamp: number;
  /** Clamped on read; a client that miscomputes it still gets its audio through. */
  level: number;
  flags: number;
}

export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return VOICE_LEVEL_MIN;
  return Math.max(VOICE_LEVEL_MIN, Math.min(VOICE_LEVEL_MAX, Math.round(level)));
}

/**
 * Write a header into the first eight bytes of `into`, which the caller has
 * sized for header plus payload.
 */
export function packVoiceHeader(into: Uint8Array, header: VoiceFrameHeader): void {
  const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
  view.setUint16(0, header.seq & 0xffff);
  view.setUint32(2, header.timestamp >>> 0);
  view.setInt8(6, clampLevel(header.level));
  view.setUint8(7, header.flags & 0xff);
}

/**
 * Read a header off a client frame. Null when the bytes are not a frame at
 * all — too short, or too long — which is the only reason to drop one. A
 * strange level is clamped, not refused: bad metadata never costs audio.
 */
export function parseVoiceHeader(frame: Uint8Array): VoiceFrameHeader | null {
  if (frame.byteLength < VOICE_HEADER_BYTES || frame.byteLength > VOICE_FRAME_MAX_BYTES) {
    return null;
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return {
    seq: view.getUint16(0),
    timestamp: view.getUint32(2),
    level: clampLevel(view.getInt8(6)),
    flags: view.getUint8(7),
  };
}

// --- control messages ---------------------------------------------------------

/** The first thing a client sends: which game session this socket speaks for. */
export interface VoiceHello {
  type: 'hello';
  /** The game session token — the same credential the office join used. */
  token: string;
  /** The Colyseus session id this person holds in the office right now. */
  sessionId: string;
  workspaceId: string;
}

export interface VoicePeer {
  sessionId: string;
  /** The byte the relay puts in front of this peer's frames, for this receiver. */
  peerIndex: number;
  name: string;
}

export type VoiceServerMessage =
  | { type: 'welcome'; sessionId: string }
  /** Who you can hear changed. `joined` before their first frame, always. */
  | { type: 'peers'; joined: VoicePeer[]; left: string[] }
  | { type: 'error'; code: string; message: string };

export type VoiceClientMessage = VoiceHello;

/** Why the relay closed a socket. 4xxx, so they never collide with the protocol's own. */
export const VOICE_CLOSE = {
  /** The first message was not a hello, or was malformed. */
  BAD_HANDSHAKE: 4400,
  /** The token did not verify, or belongs to somebody other than that session. */
  UNAUTHORISED: 4401,
  /** No such human is in that office right now. Agents land here too. */
  NO_PRESENCE: 4404,
  /** Three heartbeats went unanswered. */
  TIMEOUT: 4408,
  /** A newer socket for the same session took over. */
  REPLACED: 4409,
  /** The game session ended; the voice socket goes with it. */
  GONE: 4410,
} as const;

/** Heartbeat: a ping every 30 s, closed after three unanswered. */
export const VOICE_HEARTBEAT_MS = 30_000;
export const VOICE_HEARTBEAT_MISSES = 3;
/** Beyond this many people talking at once into one ear, the newest is dropped. */
export const VOICE_SPEAKERS_SOFT_CAP = 25;

// --- who hears whom ----------------------------------------------------------

/** Leave a little later than you entered, so a boundary is not a flicker. */
export const VOICE_LEAVE_MARGIN_TILES = 2;

export interface EarshotPlayer {
  id: string;
  kind: 'human' | 'agent';
  /** Tile units, fractional. */
  x: number;
  y: number;
}

/** A pair that started or stopped hearing each other. Symmetric: `a` and `b` both. */
export interface EarshotDelta {
  a: string;
  b: string;
  kind: 'enter' | 'leave';
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/**
 * The earshot graph of an office, kept across ticks so it can say what
 * changed rather than what is.
 *
 * The one chokepoint for the rule that agents have no voice: an agent never
 * enters a pair, so it is never a peer, never a receiver, never an index. A
 * relay that trusts this class cannot be talked into sending audio to an
 * agent by any later change elsewhere.
 *
 * Hysteresis: a pair enters at `radius` and leaves at `radius + margin`. Two
 * people rocking on the boundary hear each other steadily rather than in
 * bursts, and the peer table on each end is not rebuilt twenty times a second.
 */
export class EarshotTracker {
  readonly #pairs = new Set<string>();

  constructor(private readonly leaveMargin = VOICE_LEAVE_MARGIN_TILES) {}

  /** Recompute against current positions. Returns only what changed. */
  update(players: readonly EarshotPlayer[], radius: number): EarshotDelta[] {
    const humans = players.filter((player) => player.kind === 'human');
    const seen = new Set<string>();
    const deltas: EarshotDelta[] = [];

    for (let i = 0; i < humans.length; i += 1) {
      for (let j = i + 1; j < humans.length; j += 1) {
        const a = humans[i]!;
        const b = humans[j]!;
        const key = pairKey(a.id, b.id);
        seen.add(key);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const inside = this.#pairs.has(key);
        if (!inside && distance <= radius) {
          this.#pairs.add(key);
          deltas.push({ a: a.id, b: b.id, kind: 'enter' });
        } else if (inside && distance > radius + this.leaveMargin) {
          this.#pairs.delete(key);
          deltas.push({ a: a.id, b: b.id, kind: 'leave' });
        }
      }
    }

    // A pair whose member is gone (left, or stopped being a human) leaves.
    for (const key of this.#pairs) {
      if (seen.has(key)) continue;
      this.#pairs.delete(key);
      const [a, b] = key.split(' ') as [string, string];
      deltas.push({ a, b, kind: 'leave' });
    }
    return deltas;
  }

  /** Somebody left the office: every pair they were in ends now. */
  remove(id: string): EarshotDelta[] {
    const deltas: EarshotDelta[] = [];
    for (const key of this.#pairs) {
      const [a, b] = key.split(' ') as [string, string];
      if (a !== id && b !== id) continue;
      this.#pairs.delete(key);
      deltas.push({ a, b, kind: 'leave' });
    }
    return deltas;
  }

  /** Who `id` can hear right now. */
  hearers(id: string): string[] {
    const out: string[] = [];
    for (const key of this.#pairs) {
      const [a, b] = key.split(' ') as [string, string];
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }
}

// --- what the page shows -------------------------------------------------------

/** The voice client, as the UI sees it. Emitted on every change. */
export interface VoiceUiState {
  /** Whether this browser can do voice at all, and why not. */
  support: 'ok' | 'unsupported' | 'blocked';
  /** The relay socket. Closed while alone with agents — deliberately. */
  socket: 'closed' | 'connecting' | 'open';
  /** The switch the person controls. Muted is the default, and muted is silence on the wire. */
  muted: boolean;
  /**
   * The microphone itself. `off`: not held — never asked for, or let go
   * because nobody is near. `open`: held, nothing sent. `live`: sending.
   */
  mic: 'off' | 'open' | 'live';
  /** Push-to-talk held right now. */
  talking: boolean;
  /** Session ids of the peers speaking now, by their frames. */
  speaking: string[];
  /** How many people this socket can hear. */
  peers: number;
  /** Microphones the browser will admit to, once permission was given. */
  devices: Array<{ id: string; label: string }>;
  deviceId: string | null;
  /** A one-line reason the last thing did not work, or null. */
  error: string | null;
  /**
   * For instrumentation (Step 0.12), kept by the client and read by nobody
   * yet: time with a socket open, and the most people heard at once.
   */
  stats: { connectedMs: number; peersMax: number };
}
