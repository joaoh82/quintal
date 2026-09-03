import {
  AgentMessage,
  AgentServerMessage,
  type AgentChatEvent,
  type AgentErrorPayload,
  type AgentMentionEvent,
  type AgentOccupant,
  type AgentHostReportPayload,
  type AgentReadyPayload,
  type AgentResultPayload,
  type AgentRosterEvent,
  type LookAroundResult,
  type MemoryGetResult,
  type MemorySetResult,
  type MessagesGetResult,
} from '@quintal/shared';
import { Client, type Room } from 'colyseus.js';

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
  roster: (roster: AgentRosterEvent) => void;
  error: (error: AgentErrorPayload) => void;
  /** The socket dropped. `code` 4000 means we or the server closed on purpose. */
  closed: (code: number) => void;
}

const REQUEST_TIMEOUT_MS = 10_000;

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

  constructor(
    private readonly url: string,
    private readonly agentKey: string,
    private readonly mapId: string,
    /** Which office's room to join. Empty when the key alone decides. */
    private readonly workspaceId: string,
    /** Machine credential, when this agent was defined in the office. */
    private readonly host?: { token: string; agentId: string },
  ) {}

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
   * The office to join.
   *
   * Office-defined agents are told by the fleet response. An agent holding
   * only its own key has to ask, because the room has to be named before the
   * server can authenticate anything — that is the routing layer, not a
   * policy. The office proves the same fact again from the same key on join.
   */
  async #office(): Promise<string> {
    if (this.workspaceId.length > 0) return this.workspaceId;

    const response = await fetch(new URL('/api/agent/office', this.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentKey}` },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'That agent key is unknown or revoked.'
          : `Could not find this agent's office (${response.status}).`,
      );
    }
    const body = (await response.json()) as { workspaceId?: unknown };
    if (typeof body.workspaceId !== 'string' || body.workspaceId.length === 0) {
      throw new Error("The office did not say which office this agent is in.");
    }
    return body.workspaceId;
  }

  async connect(): Promise<AgentReadyPayload> {
    const workspaceId = await this.#office();
    const client = new Client(new URL('/colyseus', this.url).toString());
    const room = await client.joinOrCreate('office', {
      // Exactly one credential travels: a host token identifies the machine
      // and names the agent, an agent key is the agent. Sending both would
      // leave which one authorised the join ambiguous in the audit log.
      ...(this.host
        ? { hostToken: this.host.token, agentId: this.host.agentId }
        : { agentKey: this.agentKey }),
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
    room.onMessage(AgentServerMessage.Roster, (roster: AgentRosterEvent) => {
      this.#roster = roster;
      this.#handlers.roster?.(roster);
    });
    room.onMessage(AgentServerMessage.Error, (error: AgentErrorPayload) =>
      this.#handlers.error?.(error),
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

  say(text: string): void {
    this.#room?.send(AgentMessage.Say, { text });
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

  setStatus(status: string): void {
    this.#room?.send(AgentMessage.SetStatus, { status });
  }

  // --- queries -------------------------------------------------------------

  lookAround(): Promise<LookAroundResult> {
    return this.#request<LookAroundResult>(AgentMessage.LookAround, {});
  }

  messagesGet(scope: 'nearby' | 'zone', n: number): Promise<MessagesGetResult> {
    return this.#request<MessagesGetResult>(AgentMessage.MessagesGet, { scope, n });
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
  | 'hostReport'
  | 'moveToZone'
  | 'moveToPerson'
  | 'lookAround'
  | 'messagesGet'
  | 'memoryGet'
  | 'memorySet'
  | 'occupants'
  | 'on'
>;
