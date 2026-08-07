/**
 * One ACP session per (agent, zone), LRU-capped.
 *
 * Why zones and not one session per agent: a zone is a context scope. The
 * conversation you have standing in the Deep Work room is a different thread
 * from the one in the Agent Bay, and giving each its own session is what stops
 * an agent dragging the whole day's context into every exchange. It also means
 * a task that gets its own room gets its own fresh session for free.
 *
 * The cap exists because sessions cost tokens and harnesses keep them warm. Four
 * is enough for a lobby plus three rooms; past that the least recently used one
 * is ended rather than left to rot.
 */

/** The open floor is a scope too — everything outside a named zone. */
export const LOBBY_SCOPE = 'lobby';

export const MAX_LIVE_SESSIONS = 4;

export interface SessionRecord {
  /** The scope key: a zoneId, or LOBBY_SCOPE. */
  scope: string;
  /** ACP session id, from `session/new`. */
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
  /** Turns completed in this session. Only used for logging. */
  turns: number;
}

export interface SessionStoreOptions {
  max?: number;
  /** Called when a session is evicted or recycled, so the caller can end it. */
  onEvict?: (record: SessionRecord, reason: 'lru' | 'rotate') => void;
  now?: () => number;
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #max: number;
  readonly #onEvict: (record: SessionRecord, reason: 'lru' | 'rotate') => void;
  readonly #now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.#max = options.max ?? MAX_LIVE_SESSIONS;
    this.#onEvict = options.onEvict ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#sessions.size;
  }

  scopes(): string[] {
    return [...this.#sessions.keys()];
  }

  get(scope: string): SessionRecord | undefined {
    const record = this.#sessions.get(scope);
    if (record) record.lastUsedAt = this.#now();
    return record;
  }

  /**
   * Record a newly created session, evicting the least recently used one first
   * if we are at capacity.
   */
  put(scope: string, sessionId: string): SessionRecord {
    const existing = this.#sessions.get(scope);
    if (existing) this.#onEvict(existing, 'rotate');

    if (!existing && this.#sessions.size >= this.#max) {
      const oldest = [...this.#sessions.values()].sort(
        (a, b) => a.lastUsedAt - b.lastUsedAt,
      )[0];
      if (oldest) {
        this.#sessions.delete(oldest.scope);
        this.#onEvict(oldest, 'lru');
      }
    }

    const record: SessionRecord = {
      scope,
      sessionId,
      createdAt: this.#now(),
      lastUsedAt: this.#now(),
      turns: 0,
    };
    this.#sessions.set(scope, record);
    return record;
  }

  /** Drop a scope's session — after `!rotate`, or a token-limit stop reason. */
  drop(scope: string, reason: 'lru' | 'rotate' = 'rotate'): SessionRecord | undefined {
    const record = this.#sessions.get(scope);
    if (!record) return undefined;
    this.#sessions.delete(scope);
    this.#onEvict(record, reason);
    return record;
  }

  clear(): void {
    for (const record of this.#sessions.values()) this.#onEvict(record, 'rotate');
    this.#sessions.clear();
  }
}
