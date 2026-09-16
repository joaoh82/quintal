import { createHash, randomUUID } from 'node:crypto';
import {
  ACTIVITY_INTERVAL_MS,
  latencyRequestId,
  ACTIVITY_MAX_ITEMS,
  ACTIVITY_MAX_TEXT,
  ACTIVITY_MAX_BYTES,
  activityText,
  type AgentActivity,
  type ActivityState,
  type ActivityItem,
  type StepState,
} from '@quintal/shared';
import { isHarnessNotice } from './outbound.js';

/** ACP public fields only. Unknown results stay unknown, including a bare completed update. */
export function toolOutcome(update: Record<string, unknown>): StepState | undefined {
  const raw = update.rawOutput;
  const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const metadata =
    result.metadata && typeof result.metadata === 'object'
      ? (result.metadata as Record<string, unknown>)
      : {};
  const details =
    result.details && typeof result.details === 'object'
      ? (result.details as Record<string, unknown>)
      : {};
  // Observed ACP payloads: Codex exit_code; opencode metadata.exit; OMP details.exitCode.
  const code =
    update.exitCode ??
    update.exit_code ??
    result.exitCode ??
    result.exit_code ??
    metadata.exit ??
    details.exitCode;
  if (
    (typeof code === 'number' && code !== 0) ||
    update.status === 'failed' ||
    result.isError === true ||
    result.error
  )
    return 'failed';
  if (code === 0) return 'success';
  const hasResult =
    (typeof raw === 'string' && raw.length > 0) ||
    ['stdout', 'stderr', 'output', 'formatted_output'].some(
      (key) => typeof result[key] === 'string',
    ) ||
    (Array.isArray(result.content) && result.content.length > 0) ||
    (Array.isArray(update.content) && update.content.length > 0);
  if (update.status === 'completed') return hasResult ? 'success' : 'unknown';
  if (update.status === 'in_progress') return 'running';
  if (update.status === 'pending') return 'pending';
  return undefined;
}
export class PublicTurn {
  readonly value: AgentActivity;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #message: ActivityItem | null = null;
  #closed = false;
  #messageSeq = 0;
  #noticePrefix = '';
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #said = new Set<string>();
  constructor(
    scope: { channelId?: string; zoneId?: string },
    private readonly publish: (v: AgentActivity) => void,
    requestId?: string,
  ) {
    const turnId = randomUUID();
    this.value = {
      version: 1,
      turnId,
      requestId: latencyRequestId(requestId) ?? turnId,
      ...(latencyRequestId(requestId) ? { requestIds: [latencyRequestId(requestId)!] } : {}),
      workerId: 'queued',
      sessionId: 'preparing',
      sequence: 0,
      ...scope,
      state: 'queued',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
    };
    this.flush();
    this.#heartbeat = setInterval(() => this.flush(), 30_000);
    this.#heartbeat.unref?.();
  }
  state(state: ActivityState): void {
    if (this.#closed) return;
    this.value.state = state;
    this.changed();
  }
  text(text: string): void {
    if (this.#closed || !text) return;
    text = this.#noticePrefix + text;
    this.#noticePrefix = '';
    if (
      !this.#message &&
      ['Config warning: ', 'Warning: '].some(
        (prefix) => prefix.startsWith(text) || text.startsWith(prefix),
      )
    ) {
      const end = text.indexOf('\n\n');
      if (end < 0) {
        this.#noticePrefix = text.slice(0, ACTIVITY_MAX_TEXT);
        return;
      }
      text = text.slice(end + 2);
    }
    if (!text || isHarnessNotice(text)) return;
    if (!this.#message) {
      this.#message = {
        id: `${this.value.turnId}:m${++this.#messageSeq}`,
        kind: 'message',
        text: '',
        state: 'running',
        startedAt: Date.now(),
      };
      this.value.items.push(this.#message);
    }
    this.#message.text = activityText(this.#message.text + text, ACTIVITY_MAX_TEXT);
    if (isHarnessNotice(this.#message.text)) {
      this.value.items.pop();
      this.#message = null;
    }
    this.value.state = 'writing';
    this.changed();
  }
  boundary(): void {
    if (this.#message) {
      this.#message.state = 'success';
      this.#message.endedAt = Date.now();
      if (this.#said.has(this.#message.text.trim())) {
        this.value.items = this.value.items.filter((item) => item !== this.#message);
      }
      this.#message = null;
    }
  }
  say(text: string): void {
    if (this.#closed) return;
    const clean = activityText(text, ACTIVITY_MAX_TEXT).trim();
    if (!clean || this.#said.has(clean)) return;
    this.boundary();
    if (!this.value.items.some((item) => item.kind === 'message' && item.text.trim() === clean)) {
      this.text(clean);
      this.boundary();
    }
    this.#said.add(clean);
    if (this.#said.size > ACTIVITY_MAX_ITEMS) this.#said.delete(this.#said.values().next().value!);
    this.flush();
  }
  tool(update: Record<string, unknown>): void {
    if (this.#closed || typeof update.toolCallId !== 'string') return;
    const id = /^[\w.:/-]{1,120}$/.test(update.toolCallId)
      ? update.toolCallId
      : `tool:${createHash('sha256').update(update.toolCallId).digest('hex')}`;
    let item = this.value.items.find((item) => item.kind === 'tool' && item.id === id);
    if (!item) {
      this.boundary();
      item = {
        id,
        kind: 'tool',
        text: 'Tool',
        state: 'pending',
        startedAt: Date.now(),
      };
      this.value.items.push(item);
    }
    if (typeof update.title === 'string') item.text = activityText(update.title, 240);
    const input =
      update.rawInput && typeof update.rawInput === 'object'
        ? (update.rawInput as Record<string, unknown>)
        : {};
    const content = Array.isArray(update.content)
      ? (update.content as Array<{
          type?: string;
          content?: { type?: string; text?: string };
        }>)
      : [];
    if (typeof input.command === 'string') item.text = activityText(input.command, 240);
    const output =
      update.rawOutput && typeof update.rawOutput === 'object'
        ? (update.rawOutput as Record<string, unknown>)
        : {};
    const rawContent = Array.isArray(output.content)
      ? (output.content as Array<{ type?: string; text?: string }>)
      : [];
    const details = [
      typeof update.rawOutput === 'string' ? update.rawOutput : '',
      ...rawContent.filter((c) => c.type === 'text').map((c) => c.text ?? ''),
      typeof input.command === 'string' ? input.command : '',
      ...['stdout', 'stderr', 'output', 'formatted_output'].map((key) =>
        typeof output[key] === 'string' ? (output[key] as string) : '',
      ),
      ...content
        .filter((c) => c.type === 'content' && c.content?.type === 'text')
        .map((c) => c.content?.text ?? ''),
    ]
      .filter(Boolean)
      .join('\n');
    if (details) item.detail = activityText(details);
    const state = toolOutcome({
      ...update,
      status: update.status ?? (item.state === 'unknown' ? 'completed' : undefined),
    });
    // Late pending/running patches cannot restart a finished tool. Failure wins.
    if (
      state &&
      (!item.endedAt || state === 'failed' || (item.state === 'unknown' && state === 'success'))
    )
      item.state = state;
    if (['success', 'failed', 'unknown'].includes(item.state)) item.endedAt ??= Date.now();
    this.value.state = 'running';
    this.changed();
  }
  finish(state: ActivityState): void {
    if (this.#closed) return;
    this.boundary();
    this.value.state = state;
    this.value.updatedAt = Date.now();
    for (const item of this.value.items)
      if (item.state === 'pending' || item.state === 'running') {
        item.state =
          state === 'cancelled' ? 'cancelled' : state === 'completed' ? 'unknown' : 'interrupted';
        item.endedAt = Date.now();
      }
    clearInterval(this.#heartbeat);
    this.flush();
    this.#closed = true;
  }
  changed(): void {
    this.value.updatedAt = Date.now();
    if (!this.#timer) this.#timer = setTimeout(() => this.flush(), ACTIVITY_INTERVAL_MS);
  }
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.value.items = this.value.items.slice(-ACTIVITY_MAX_ITEMS);
    while (
      new TextEncoder().encode(JSON.stringify(this.value)).length > ACTIVITY_MAX_BYTES - 2000 &&
      this.value.items.length > 1
    )
      this.value.items.shift();
    this.value.sequence++;
    this.publish(structuredClone(this.value));
  }
}
