import {
  AgentMessage,
  AgentServerMessage,
  type AgentBanterEvent,
  type AgentChannelChatEvent,
  type AgentChannelsEvent,
  type AgentChatEvent,
  type AgentEmotePayload,
  type AgentErrorPayload,
  type AgentMentionEvent,
  type AgentOccupant,
  type AgentHostReportPayload,
  type AgentMessagesGetPayload,
  type AgentReadyPayload,
  type AgentResultPayload,
  type AgentRosterEvent,
  type AgentSayPayload,
  type AgentSetStatusPayload,
  type ChannelRef,
  type LookAroundResult,
  type MemoryGetResult,
  type MemorySetResult,
  type MessagesGetResult,
} from '@quintal/shared';
import { buildAuthPayload, signAuthPayload } from '@quintal/shared';
import { Client, type Room } from 'colyseus.js';

import type { AgentCredential } from '../credential.js';

/**
 * The harness's half of the gateway protocol from step 0.4.
 *
 * Deliberately thin: it owns the socket and the request/response correlation,
 * and knows nothing about ACP, sessions or prompts. Everything above it treats
 * the office as an event source and a small command surface.
 */

export interface GatewayEvents {
  ready: (ready: AgentReadyPayload) => void;
  chat: (message: AgentChatEvent) => void;
  mention: (message: AgentMentionEvent) => void;
  /** A line in a channel this agent is in. `mentioned` says whether it named us. */
  channelChat: (message: AgentChannelChatEvent) => void;
  /** The office's current word on which channels this agent is in. */
  channels: (event: AgentChannelsEvent) => void;
  roster: (roster: AgentRosterEvent) => void;
  /** A moment with another idle agent: one line, or nothing. */
  banter: (event: AgentBanterEvent) => void;
  error: (error: AgentErrorPayload) => void;
  /** The socket dropped. `code` 4000 means we or the server closed on purpose. */
  closed: (code: number) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** A signed challenge: the agent's key, and proof it holds the other half. */
interface ChallengeProof {
  agentPubkey: string;
  sig: string;
  nonce: string;
  timestamp: number;
}

/**
 * The network, replaceable. A test hands in a `fetch` that answers the
 * challenge and a `join` that records what was presented at the door, and
 * the client's whole credential ceremony runs without an office.
 */
export interface GatewayDeps {
  fetch?: typeof fetch;
  join?: (endpoint: string, options: Record<string, unknown>) => Promise<Room>;
}

export class GatewayClient {
  #room: Room | null = null;
  #requestSeq = 0;
  readonly #pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly #handlers: Partial<GatewayEvents> = {};

  #ready: AgentReadyPayload | null = null;
  #roster: AgentRosterEvent | null = null;
  #channels: ChannelRef[] | null = null;

  readonly #fetch: typeof fetch;
  readonly #join: (endpoint: string, options: Record<string, unknown>) => Promise<Room>;

  constructor(
    private readonly url: string,
    /** What to present at the door. See `credentialFor`. */
    private readonly credential: AgentCredential,
    private readonly mapId: string,
    /** Which office's room to join. Empty when the credential alone decides. */
    private readonly workspaceId: string,
    deps: GatewayDeps = {},
  ) {
    this.#fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.#join =
      deps.join ??
      ((endpoint, options) => new Client(endpoint).joinOrCreate('office', options));
  }

  on<K extends keyof GatewayEvents>(event: K, handler: GatewayEvents[K]): void {
    this.#handlers[event] = handler;
  }

  get ready(): AgentReadyPayload | null {
    return this.#ready;
  }

  get roster(): AgentRosterEvent | null {
    return this.#roster;
  }

  get connected(): boolean {
    return this.#room !== null;
  }

  /**
   * Prove we hold our key: ask for a challenge, sign it, hand back the pieces.
   *
   * Fresh every time. A nonce is single-use, so a reconnect that reused one
   * would be refused; and the origin is the office's to decide — it comes
   * back with the challenge rather than being derived from the URL we were
   * given, for the same reason a person's sign-in does.
   */
  async #prove(): Promise<ChallengeProof> {
    if (this.credential.kind !== 'keypair') {
      throw new Error('only a keypair can sign a challenge');
    }
    const response = await this.#fetch(new URL('/api/agent/challenge', this.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: this.credential.pubkey }),
    });
    if (!response.ok) {
      throw new Error(`The office would not issue a challenge (${response.status}).`);
    }
    const body = (await response.json()) as { nonce?: unknown; origin?: unknown };
    if (typeof body.nonce !== 'string' || typeof body.origin !== 'string') {
      throw new Error('The office issued a challenge we cannot sign.');
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = buildAuthPayload({ origin: body.origin, nonce: body.nonce, timestamp });
    return {
      agentPubkey: this.credential.pubkey,
      sig: signAuthPayload(this.credential.secretKey, payload),
      nonce: body.nonce,
      timestamp,
    };
  }

  /**
   * The office to join.
   *
   * Office-defined agents are told by the fleet response. An agent holding
   * only its own key has to ask, because the room has to be named before the
   * server can authenticate anything — that is the routing layer, not a
   * policy. The office proves the same fact again from the same key on join.
   */
  async #office(): Promise<string> {
    if (this.workspaceId.length > 0) return this.workspaceId;

    if (this.credential.kind === 'host') {
      throw new Error('An office-defined agent is told its office by the fleet; none was given.');
    }

    const response =
      this.credential.kind === 'keypair'
        ? await this.#fetch(new URL('/api/agent/office', this.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(await this.#prove()),
          })
        : await this.#fetch(new URL('/api/agent/office', this.url), {
            method: 'POST',
            headers: { authorization: `Bearer ${this.credential.key}` },
          });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const reason = typeof body?.error === 'string' ? body.error : '';
      throw new Error(
        response.status === 401
          ? reason || 'That agent credential is unknown or revoked.'
          : `Could not find this agent's office (${response.status}).`,
      );
    }
    const body = (await response.json()) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
      throw new Error("The office did not say which office this agent is in.");
    }
    return body.workspaceId;
  }

  /**
   * Exactly one credential travels. A keypair is preferred whenever we hold
   * one — it is the credential the office cannot forge — then a host token,
   * which identifies the machine and names the agent, then a legacy key.
   * Sending two would leave which one authorised the join ambiguous in the
   * audit log.
   */
  async #joinOptions(): Promise<Record<string, unknown>> {
    switch (this.credential.kind) {
      case 'keypair':
        return { ...(await this.#prove()) };
      case 'host':
        return { hostToken: this.credential.token, agentId: this.credential.agentId };
      case 'key':
        return { agentKey: this.credential.key };
    }
  }

  async connect(): Promise<AgentReadyPayload> {
    const workspaceId = await this.#office();
    const room = await this.#join(new URL('/colyseus', this.url).toString(), {
      ...(await this.#joinOptions()),
      mapId: this.mapId,
      workspaceId,
    });
    this.#room = room;

    // Handlers are registered before the first await so nothing sent by the
    // server immediately after join can be dropped on the floor.
    const readyPromise = new Promise<AgentReadyPayload>((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error('office never sent agent:ready')),
        REQUEST_TIMEOUT_MS,
      );

      room.onMessage(AgentServerMessage.Ready, (ready: AgentReadyPayload) => {
        clearTimeout(timer);
        this.#ready = ready;
        this.#handlers.ready?.(ready);
        resolveReady(ready);
      });
    });

    room.onMessage(AgentServerMessage.NearbyChat, (message: AgentChatEvent) =>
      this.#handlers.chat?.(message),
    );
    room.onMessage(AgentServerMessage.Mention, (message: AgentMentionEvent) =>
      this.#handlers.mention?.(message),
    );
    room.onMessage(AgentServerMessage.ChannelChat, (message: AgentChannelChatEvent) =>
      this.#handlers.channelChat?.(message),
    );
    room.onMessage(AgentServerMessage.Channels, (event: AgentChannelsEvent) => {
      this.#channels = event.channels;
      this.#handlers.channels?.(event);
    });
    room.onMessage(AgentServerMessage.Roster, (roster: AgentRosterEvent) => {
      this.#roster = roster;
      this.#handlers.roster?.(roster);
    });
    room.onMessage(AgentServerMessage.Error, (error: AgentErrorPayload) =>
      this.#handlers.error?.(error),
    );
    room.onMessage(AgentServerMessage.Banter, (event: AgentBanterEvent) =>
      this.#handlers.banter?.(event),
    );
    room.onMessage(AgentServerMessage.Heartbeat, () => {
      // Proof of life only; the harness has nothing to do with it.
    });
    room.onMessage(AgentServerMessage.Result, (result: AgentResultPayload) => {
      const pending = this.#pending.get(result.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(result.requestId);
      if (result.ok) pending.resolve(result.data);
      else pending.reject(new Error(`${result.error.code}: ${result.error.message}`));
    });

    room.onLeave((code) => {
      this.#room = null;
      this.#failPending(new Error(`gateway closed (${code})`));
      this.#handlers.closed?.(code);
    });

    return readyPromise;
  }

  async leave(): Promise<void> {
    const room = this.#room;
    this.#room = null;
    this.#failPending(new Error('gateway closed'));
    await room?.leave(true);
  }

  // --- commands ------------------------------------------------------------

  /** Speak aloud, or — with a channel — post there instead. */
  say(text: string, channelId?: string): void {
    this.#room?.send(AgentMessage.Say, {
      text,
      ...(channelId !== undefined ? { channelId } : {}),
    } satisfies AgentSayPayload);
  }

  /** The channels this agent is in, as of the office's last word on it. */
  channels(): ChannelRef[] {
    return this.#channels ?? this.#ready?.channels ?? [];
  }

  moveToZone(zoneId: string): void {
    this.#room?.send(AgentMessage.MoveTo, { zoneId });
  }

  /** Walk to whoever this names. The office resolves it and picks the tile. */
  moveToPerson(person: string): void {
    this.#room?.send(AgentMessage.MoveTo, { person });
  }

  hostReport(payload: AgentHostReportPayload): void {
    this.#room?.send(AgentMessage.HostReport, payload);
  }

  /** The status line, and — for a channel or DM turn — where the work is. */
  setStatus(status: string, channelId?: string): void {
    this.#room?.send(AgentMessage.SetStatus, {
      status,
      ...(channelId ? { channelId } : {}),
    } satisfies AgentSetStatusPayload);
  }

  /**
   * A balloon over the head, or none. `ttlMs` 0 keeps it up until the next
   * call — for balloons that reflect a state — and omitted takes the office's
   * default for a reaction.
   */
  emote(emote: string, ttlMs?: number): void {
    this.#room?.send(AgentMessage.Emote, {
      emote,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    } satisfies AgentEmotePayload);
  }

  // --- queries -------------------------------------------------------------

  lookAround(): Promise<LookAroundResult> {
    return this.#request<LookAroundResult>(AgentMessage.LookAround, {});
  }

  messagesGet(
    query: Pick<AgentMessagesGetPayload, 'scope' | 'zoneId' | 'n' | 'before'>,
  ): Promise<MessagesGetResult> {
    return this.#request<MessagesGetResult>(AgentMessage.MessagesGet, query);
  }

  memoryGet(slug: string): Promise<MemoryGetResult> {
    return this.#request<MemoryGetResult>(AgentMessage.MemoryGet, { slug });
  }

  memorySet(slug: string, content: string): Promise<MemorySetResult> {
    return this.#request<MemorySetResult>(AgentMessage.MemorySet, { slug, content });
  }

  /** Occupants as of the last roster the office sent. */
  occupants(): AgentOccupant[] {
    return this.#roster?.occupants ?? [];
  }

  #request<T>(type: string, payload: Record<string, unknown>): Promise<T> {
    const room = this.#room;
    if (!room) return Promise.reject(new Error('not connected to the office'));

    const requestId = `h${(this.#requestSeq += 1)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`${type} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      room.send(type, { ...payload, requestId });
    });
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * The gateway, as everything else is allowed to see it.
 *
 * Derived from the class with `Pick` rather than hand-written, so it cannot
 * drift from the real thing: adding a method here that `GatewayClient` does not
 * have is a compile error, and renaming one there breaks this immediately.
 *
 * It exists so `AgentRunner` can be handed a stand-in. The runner reaches the
 * network through exactly these members, and a test that cannot replace them
 * has to stand up a real office to check anything at all — which is why the
 * runner had no tests before.
 *
 * `Pick` also drops the `#private` fields, which matters: a class with private
 * members is matched nominally, so without this no object literal could ever
 * satisfy the type.
 */
export type Gateway = Pick<
  GatewayClient,
  | 'ready'
  | 'roster'
  | 'connected'
  | 'connect'
  | 'leave'
  | 'say'
  | 'setStatus'
  | 'emote'
  | 'hostReport'
  | 'moveToZone'
  | 'moveToPerson'
  | 'lookAround'
  | 'messagesGet'
  | 'memoryGet'
  | 'memorySet'
  | 'occupants'
  | 'channels'
  | 'on'
>;
