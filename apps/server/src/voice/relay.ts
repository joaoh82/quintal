import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  VOICE_CLOSE,
  VOICE_FRAME_MAX_BYTES,
  VOICE_HEARTBEAT_MISSES,
  VOICE_HEARTBEAT_MS,
  VOICE_SPEAKERS_SOFT_CAP,
  parseVoiceHeader,
  type EarshotDelta,
  type VoiceHello,
  type VoicePeer,
  type VoiceServerMessage,
} from '@quintal/shared';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

/**
 * The voice relay: Opus frames in, the same Opus frames out, to the people
 * who can hear the sender and nobody else.
 *
 * It never decodes. It reads eight bytes of header to know a frame is a
 * frame, puts one byte in front — the sender's index in the receiver's peer
 * table — and forwards the rest untouched. Who hears whom is not its
 * decision: the office computes earshot from positions on its tick and
 * tells the relay what changed. So a client cannot widen who hears it, and
 * a bug in this file cannot either; the worst it can do is drop audio.
 *
 * One socket per game session, opened with the session's own token and
 * bound to the session's id in the room. No presence in the office, no
 * voice; an agent has presence but is never a human, so it has no voice
 * either — refused at the same door.
 */

/** What the relay needs to know about an office, supplied by the room. */
export interface VoicePresence {
  roomId: string;
  workspaceId: string;
  /** The human holding this session right now, or null — for a stranger, an agent, or nobody. */
  human(sessionId: string): { name: string; userId: string } | null;
}

export interface VoiceRelayDeps {
  /** Turn a game session token into who holds it. The office's own rule, injected for tests. */
  verifyToken: (token: unknown) => Promise<{ userId: string } | null>;
  heartbeatMs?: number;
  heartbeatMisses?: number;
  speakersCap?: number;
  /**
   * How much is waiting to go out on a socket. `ws.bufferedAmount` in
   * production; a test hands in a number it controls, because a full kernel
   * buffer is not something a test can arrange on purpose.
   */
  backpressure?: (ws: WebSocket) => number;
  /** Audio is dropped, not queued, past this many bytes waiting. Control never is. */
  audioHighWater?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** How long a fresh socket has to say hello before it is shown the door. */
const HELLO_TIMEOUT_MS = 5_000;
/** A peer index is one byte. */
const MAX_PEER_INDEX = 255;
/** "Talking at once" means a frame within this long. */
const SPEAKING_WINDOW_MS = 1_000;
/** How often a receiver's dropped-frame count is worth a log line. */
const DROP_LOG_EVERY_MS = 60_000;

class Connection {
  /** Sender session id → the byte this receiver knows them by. */
  readonly indexOf = new Map<string, number>();
  readonly freeIndices: number[] = [];
  nextIndex = 0;
  missedPongs = 0;
  dropped = 0;
  lastDropLog = 0;
  /** Who has sent this receiver audio lately, for the soft cap. */
  readonly recentSenders = new Map<string, number>();

  constructor(
    readonly ws: WebSocket,
    readonly sessionId: string,
    readonly roomId: string,
  ) {}

  allocate(sender: string): number | null {
    const existing = this.indexOf.get(sender);
    if (existing !== undefined) return existing;
    let index = this.freeIndices.pop();
    if (index === undefined) {
      if (this.nextIndex > MAX_PEER_INDEX) return null;
      index = this.nextIndex;
      this.nextIndex += 1;
    }
    this.indexOf.set(sender, index);
    return index;
  }

  release(sender: string): boolean {
    const index = this.indexOf.get(sender);
    if (index === undefined) return false;
    this.indexOf.delete(sender);
    this.freeIndices.push(index);
    return true;
  }
}

interface RoomState {
  presence: VoicePresence;
  /** session id → the session ids it can hear, and that can hear it. */
  hearers: Map<string, Set<string>>;
}

export class VoiceRelay {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: VOICE_FRAME_MAX_BYTES });
  readonly #rooms = new Map<string, RoomState>();
  readonly #roomsByWorkspace = new Map<string, string>();
  readonly #connections = new Map<string, Connection>();
  readonly #verifyToken: VoiceRelayDeps['verifyToken'];
  readonly #heartbeatMs: number;
  readonly #heartbeatMisses: number;
  readonly #speakersCap: number;
  readonly #backpressure: (ws: WebSocket) => number;
  readonly #audioHighWater: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(deps: VoiceRelayDeps) {
    this.#verifyToken = deps.verifyToken;
    this.#heartbeatMs = deps.heartbeatMs ?? VOICE_HEARTBEAT_MS;
    this.#heartbeatMisses = deps.heartbeatMisses ?? VOICE_HEARTBEAT_MISSES;
    this.#speakersCap = deps.speakersCap ?? VOICE_SPEAKERS_SOFT_CAP;
    this.#backpressure = deps.backpressure ?? ((ws) => ws.bufferedAmount);
    this.#audioHighWater = deps.audioHighWater ?? 8 * VOICE_FRAME_MAX_BYTES;
    this.#log = deps.log ?? (() => undefined);
    this.#now = deps.now ?? (() => Date.now());
  }

  // --- lifecycle -------------------------------------------------------------

  /** Take a `/voice` upgrade off the HTTP server. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
    if (!this.#heartbeat) {
      this.#heartbeat = setInterval(() => this.#beat(), this.#heartbeatMs);
      this.#heartbeat.unref();
    }
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const connection of this.#connections.values()) {
      connection.ws.close(VOICE_CLOSE.GONE, 'relay closing');
    }
    this.#connections.clear();
    this.#wss.close();
  }

  // --- what the office tells the relay -----------------------------------------

  registerRoom(presence: VoicePresence): void {
    this.#rooms.set(presence.roomId, { presence, hearers: new Map() });
    this.#roomsByWorkspace.set(presence.workspaceId, presence.roomId);
  }

  unregisterRoom(roomId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    for (const connection of this.#connections.values()) {
      if (connection.roomId === roomId) {
        connection.ws.close(VOICE_CLOSE.GONE, 'the office closed');
        this.#connections.delete(connection.sessionId);
      }
    }
    this.#roomsByWorkspace.delete(room.presence.workspaceId);
    this.#rooms.delete(roomId);
  }

  /**
   * Earshot changed. Each delta is one pair, both directions: `a` starts or
   * stops hearing `b`, and `b` likewise `a`. Every receiver with a socket
   * hears about it once, in one message, before any frame from a new peer.
   */
  updatePeers(roomId: string, deltas: readonly EarshotDelta[]): void {
    const room = this.#rooms.get(roomId);
    if (!room || deltas.length === 0) return;

    const joined = new Map<string, VoicePeer[]>();
    const left = new Map<string, string[]>();
    const note = (receiver: string, sender: string, kind: EarshotDelta['kind']): void => {
      const set = room.hearers.get(receiver) ?? new Set<string>();
      if (kind === 'enter') set.add(sender);
      else set.delete(sender);
      room.hearers.set(receiver, set);

      const connection = this.#connections.get(receiver);
      if (!connection) return;
      if (kind === 'enter') {
        const index = connection.allocate(sender);
        if (index === null) return;
        const name = room.presence.human(sender)?.name ?? '';
        (joined.get(receiver) ?? joined.set(receiver, []).get(receiver))!.push({
          sessionId: sender,
          peerIndex: index,
          name,
        });
      } else if (connection.release(sender)) {
        (left.get(receiver) ?? left.set(receiver, []).get(receiver))!.push(sender);
        connection.recentSenders.delete(sender);
      }
    };

    for (const delta of deltas) {
      note(delta.a, delta.b, delta.kind);
      note(delta.b, delta.a, delta.kind);
    }

    const receivers = new Set([...joined.keys(), ...left.keys()]);
    for (const receiver of receivers) {
      this.#send(receiver, {
        type: 'peers',
        joined: joined.get(receiver) ?? [],
        left: left.get(receiver) ?? [],
      });
    }
  }

  /** The game session ended. Its voice goes with it, and everybody stops hearing it. */
  sessionLeft(roomId: string, sessionId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    const connection = this.#connections.get(sessionId);
    if (connection) {
      connection.ws.close(VOICE_CLOSE.GONE, 'the session ended');
      this.#connections.delete(sessionId);
    }
    const hearers = room.hearers.get(sessionId);
    room.hearers.delete(sessionId);
    if (hearers && hearers.size > 0) {
      this.updatePeers(
        roomId,
        [...hearers].map((other) => ({ a: sessionId, b: other, kind: 'leave' as const })),
      );
    }
  }

  /** For tests and diagnostics: what one receiver has lost to backpressure. */
  dropped(sessionId: string): number {
    return this.#connections.get(sessionId)?.dropped ?? 0;
  }

  // --- the door ------------------------------------------------------------------

  #accept(ws: WebSocket): void {
    const timer = setTimeout(() => {
      ws.close(VOICE_CLOSE.BAD_HANDSHAKE, 'say hello first');
    }, HELLO_TIMEOUT_MS);

    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      if (isBinary) {
        ws.close(VOICE_CLOSE.BAD_HANDSHAKE, 'the first message is a hello, not a frame');
        return;
      }
      void this.#handshake(ws, data);
    });
  }

  async #handshake(ws: WebSocket, data: RawData): Promise<void> {
    const hello = parseHello(data);
    if (!hello) {
      ws.close(VOICE_CLOSE.BAD_HANDSHAKE, 'expected { type: "hello", token, sessionId, workspaceId }');
      return;
    }

    // Presence first: it is the cheap check, and "no such person here"
    // is the answer for an agent as much as for a stranger — the relay has
    // no separate notion of an agent, only of humans in the office.
    const roomId = this.#roomsByWorkspace.get(hello.workspaceId);
    const room = roomId ? this.#rooms.get(roomId) : undefined;
    const human = room?.presence.human(hello.sessionId) ?? null;
    if (!room || !roomId || !human) {
      ws.close(VOICE_CLOSE.NO_PRESENCE, 'no such person in that office right now');
      return;
    }

    let holder: { userId: string } | null = null;
    try {
      holder = await this.#verifyToken(hello.token);
    } catch {
      holder = null;
    }
    // Bound to the session's owner, not just to a valid token: a valid
    // session of yours does not let you speak as somebody else's seat.
    if (!holder || holder.userId !== human.userId) {
      ws.close(VOICE_CLOSE.UNAUTHORISED, 'that token does not hold that session');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    // One socket per session. A reconnecting client's new socket wins; the
    // old one, if it is still around, is told why.
    const previous = this.#connections.get(hello.sessionId);
    if (previous) {
      previous.ws.close(VOICE_CLOSE.REPLACED, 'a newer socket took over');
    }

    const connection = new Connection(ws, hello.sessionId, roomId);
    this.#connections.set(hello.sessionId, connection);

    ws.on('pong', () => {
      connection.missedPongs = 0;
    });
    ws.on('message', (frame: RawData, isBinary: boolean) => {
      if (isBinary) this.#relay(connection, room, frame);
      // A second text message means nothing; the protocol has one.
    });
    ws.on('close', () => {
      if (this.#connections.get(hello.sessionId) === connection) {
        this.#connections.delete(hello.sessionId);
      }
    });

    this.#send(hello.sessionId, { type: 'welcome', sessionId: hello.sessionId });

    // Everybody already in earshot, before any of their frames.
    const hearers = room.hearers.get(hello.sessionId);
    if (hearers && hearers.size > 0) {
      const joined: VoicePeer[] = [];
      for (const sender of hearers) {
        const index = connection.allocate(sender);
        if (index === null) break;
        joined.push({ sessionId: sender, peerIndex: index, name: room.presence.human(sender)?.name ?? '' });
      }
      this.#send(hello.sessionId, { type: 'peers', joined, left: [] });
    }
  }

  // --- frames ----------------------------------------------------------------------

  #relay(sender: Connection, room: RoomState, data: RawData): void {
    const frame = toBuffer(data);
    // The one reason to refuse a frame: it is not the shape of one. A strange
    // header is forwarded as it came; receivers clamp what they read.
    if (!parseVoiceHeader(frame)) return;

    const hearers = room.hearers.get(sender.sessionId);
    if (!hearers || hearers.size === 0) return;

    const now = this.#now();
    for (const receiverId of hearers) {
      const receiver = this.#connections.get(receiverId);
      if (!receiver) continue;
      const index = receiver.indexOf.get(sender.sessionId);
      if (index === undefined) continue;

      if (!this.#underCap(receiver, sender.sessionId, now)) continue;

      if (this.#backpressure(receiver.ws) > this.#audioHighWater) {
        receiver.dropped += 1;
        if (now - receiver.lastDropLog > DROP_LOG_EVERY_MS) {
          receiver.lastDropLog = now;
          this.#log(`[voice] ${receiverId} is behind; ${receiver.dropped} frames dropped so far`);
        }
        continue;
      }

      receiver.ws.send(Buffer.concat([Buffer.from([index]), frame]), { binary: true });
    }
  }

  /**
   * Twenty-five people talking into one ear is the soft cap. Past it the
   * newest speaker is dropped for that receiver — a room that loud is not
   * one anybody can follow, and the receiver's CPU is the scarce thing.
   */
  #underCap(receiver: Connection, sender: string, now: number): boolean {
    for (const [id, at] of receiver.recentSenders) {
      if (now - at > SPEAKING_WINDOW_MS) receiver.recentSenders.delete(id);
    }
    if (!receiver.recentSenders.has(sender) && receiver.recentSenders.size >= this.#speakersCap) {
      return false;
    }
    receiver.recentSenders.set(sender, now);
    return true;
  }

  // --- control ----------------------------------------------------------------------

  /** Control messages always go: they are small, and a peer table that lags is worse than a dropped frame. */
  #send(sessionId: string, message: VoiceServerMessage): void {
    const connection = this.#connections.get(sessionId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return;
    connection.ws.send(JSON.stringify(message));
  }

  #beat(): void {
    for (const connection of this.#connections.values()) {
      if (connection.missedPongs >= this.#heartbeatMisses) {
        connection.ws.close(VOICE_CLOSE.TIMEOUT, 'no heartbeat');
        this.#connections.delete(connection.sessionId);
        continue;
      }
      connection.missedPongs += 1;
      if (connection.ws.readyState === WebSocket.OPEN) connection.ws.ping();
    }
  }
}

function parseHello(data: RawData): VoiceHello | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toBuffer(data).toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const hello = parsed as Record<string, unknown>;
  if (hello.type !== 'hello') return null;
  if (typeof hello.token !== 'string' || hello.token.length === 0) return null;
  if (typeof hello.sessionId !== 'string' || hello.sessionId.length === 0) return null;
  if (typeof hello.workspaceId !== 'string' || hello.workspaceId.length === 0) return null;
  return {
    type: 'hello',
    token: hello.token,
    sessionId: hello.sessionId,
    workspaceId: hello.workspaceId,
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
