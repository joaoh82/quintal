import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * Answering more than one conversation at once.
 *
 * Asked to review a pull request in #engineering, Lunkwill reviewed it — and
 * a direct message sent while he did got nothing: no "thinking", no reply,
 * until the review was done. The harness ran one prompt at a time per
 * agent, and the DM's view showed no sign of the queue it was in.
 *
 * Now an agent has a parallelism: how many conversations it answers at
 * once, each on a runtime process of its own. These tests pin what that
 * means — the DM is answered alongside the review and shows as being
 * answered; with parallelism 1 the old order holds; a message for another
 * conversation is not called a steer; a turn that cannot start says so
 * rather than losing the message; a session evicted from the cap is
 * cancelled; and memory written by one session reaches the others.
 */

interface Handlers {
  chat?: (message: unknown) => void;
  channelChat?: (message: unknown) => void;
}

const ENGINEERING = { id: 'ch-eng', kind: 'channel', name: 'Engineering', slug: 'engineering' };
const DM = { id: 'dm-josh', kind: 'dm', name: 'Josh', slug: '' };
const OTHER = (n: number) => ({ id: `ch-${n}`, kind: 'channel', name: `Room ${n}`, slug: `room-${n}` });

type Said = Array<{ text: string; channelId: string | undefined; at: number }>;
type Statuses = Array<{
  status: string;
  channelId: string | undefined;
  where: { channelIds?: string[]; spatial?: boolean } | undefined;
  at: number;
}>;

function fakeGateway(
  handlers: Handlers,
  said: Said,
  statuses: Statuses,
  options: {
    parallelism?: number;
    channels?: unknown[];
    core?: string;
    /** Refuse the first write as a conflict, the way the office does. */
    conflictOnce?: boolean;
    writes?: Array<{ slug: string; content: string; expectedHash?: string }>;
  } = {},
): Gateway {
  const channels = options.channels ?? [ENGINEERING, DM];
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes: ['chat', 'status'],
    channels,
    limits: {
      walkUpRadiusTiles: 4,
      ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}),
    },
  };
  let core = options.core ?? '';
  let conflicts = options.conflictOnce ? 1 : 0;
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push({ text, channelId, at: Date.now() });
    },
    setStatus: (status: string, channelId?: string, where?: Statuses[number]['where']) => {
      statuses.push({ status, channelId, where, at: Date.now() });
    },
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: core, hash: `h-${core.length}` }),
    memorySet: async (slug: string, content: string, expectedHash?: string) => {
      options.writes?.push({ slug, content, ...(expectedHash !== undefined ? { expectedHash } : {}) });
      if (conflicts > 0) {
        conflicts -= 1;
        throw new Error('conflict: "core" changed since you read it');
      }
      core = content;
      return { ok: true };
    },
    occupants: () => [],
    channels: () => channels,
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
}

function config(cwd: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'Bob',
    key: 'agent-key',
    hostToken: '',
    agentId: '',
    harness: 'custom',
    command: [process.execPath, FAKE],
    cwd,
    rootedAtReposDir: false,
    url: 'http://localhost:0',
    mapId: 'hq',
    workspaceId: 'ws-1',
    ...over,
  } as unknown as AgentConfig;
}

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
}

function requests(path: string): Recorded[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Recorded);
}

function promptTexts(path: string): string[] {
  return requests(path)
    .filter((entry) => entry.method === 'session/prompt')
    .map((entry) => {
      const prompt = (entry.params as { prompt?: Array<{ text?: string }> }).prompt ?? [];
      return prompt.map((block) => block.text ?? '').join('');
    });
}

async function until(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function aloud(handlers: Handlers, text: string): void {
  handlers.chat?.({
    from: 's',
    fromUserId: 'owner-1',
    fromName: 'Josh',
    fromKind: 'human',
    text,
    distance: 1,
    sentAt: Date.now(),
  });
}

function mention(handlers: Handlers, channel: unknown, text: string, at: number): void {
  handlers.channelChat?.({
    from: 'sess-josh',
    fromUserId: 'owner-1',
    fromName: 'Josh',
    fromKind: 'human',
    text,
    channel,
    mentioned: true,
    sentAt: at,
  });
}

describe('answering several conversations at once', () => {
  let current: AgentRunner | null = null;

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('FAKE_')) delete process.env[key];
    }
  }

  after(stopCurrent);

  async function start(
    env: Record<string, string>,
    gatewayOptions: Parameters<typeof fakeGateway>[3] = {},
    configOver: Partial<AgentConfig> = {},
  ): Promise<{ handlers: Handlers; record: string; said: Said; statuses: Statuses }> {
    await stopCurrent();
    const dir = mkdtempSync(join(tmpdir(), 'quintal-parallel-'));
    const record = join(dir, 'requests.jsonl');
    process.env.FAKE_RECORD = record;
    for (const [key, value] of Object.entries(env)) process.env[key] = value;

    const handlers: Handlers = {};
    const said: Said = [];
    const statuses: Statuses = [];
    current = new AgentRunner(
      config(dir, configOver),
      undefined,
      fakeGateway(handlers, said, statuses, gatewayOptions),
    );
    await current.start();
    return { handlers, record, said, statuses };
  }

  it('answers a DM while a channel review is still running, and shows it working in both', async () => {
    const { handlers, record, said, statuses } = await start(
      { FAKE_DELAY_MS: '1500', FAKE_REPLY: 'done' },
      { parallelism: 2 },
    );
    assert.equal(current?.parallelism, 2, 'the office said two');

    const t0 = Date.now();
    mention(handlers, ENGINEERING, '@Bob review PR 76', t0);
    await until(
      () => statuses.some((s) => s.status === 'thinking' && s.channelId === ENGINEERING.id),
      'the channel turn to start',
    );
    mention(handlers, DM, 'what model are you on?', t0 + 10);

    // The DM shows the agent working in it *while* the channel turn runs.
    await until(
      () => statuses.some((s) => s.where?.channelIds?.includes(DM.id) === true),
      'the DM to be worked in',
    );
    assert.equal(said.length, 0, 'nothing answered yet — the review is still running');
    const both = statuses.find(
      (s) => s.where?.channelIds?.includes(DM.id) && s.where?.channelIds?.includes(ENGINEERING.id),
    );
    assert.ok(both, `both conversations named at once: ${JSON.stringify(statuses.map((s) => s.where))}`);
    // Alongside, not after: both prompts are with the runtime before either
    // has answered. (The replies themselves leave 2s apart whatever happens
    // — the office allows an agent one line every two seconds.)
    await until(() => promptTexts(record).length === 2, 'the DM prompt to be sent');
    assert.equal(said.length, 0, 'the DM was prompted while the review still ran');
    assert.ok(
      promptTexts(record).some((t) => t.includes('what model are you on?')),
      'and it was the DM',
    );

    await until(() => said.length === 2, 'both replies');
    const dm = said.find((s) => s.channelId === DM.id);
    const channel = said.find((s) => s.channelId === ENGINEERING.id);
    assert.ok(dm && channel, `one reply each: ${JSON.stringify(said)}`);

    await until(() => statuses.at(-1)?.status === '', 'idle at the end');
    assert.deepEqual(statuses.at(-1)?.where, { channelIds: [], spatial: false });
  });

  it('with parallelism 1 the DM waits for the review, as it always did', async () => {
    const { handlers, said } = await start(
      { FAKE_DELAY_MS: '1200', FAKE_REPLY: 'done' },
      { parallelism: 4 },
      // The fleet file has the last word over the office.
      { parallelism: 1 },
    );
    assert.equal(current?.parallelism, 1);

    const t0 = Date.now();
    mention(handlers, ENGINEERING, '@Bob review PR 76', t0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    mention(handlers, DM, 'what model are you on?', t0 + 100);

    await until(() => said.length === 2, 'both replies');
    const dm = said.find((s) => s.channelId === DM.id);
    const channel = said.find((s) => s.channelId === ENGINEERING.id);
    assert.ok(dm && channel);
    assert.ok(dm.at - channel.at >= 1000, `one after the other (${dm.at - channel.at}ms apart)`);
  });

  it('calls a message for another conversation a fresh ask, not a steer', async () => {
    const { handlers, record, said } = await start(
      { FAKE_DELAY_MS: '600', FAKE_REPLY: 'ok' },
      { parallelism: 1 },
    );

    const t0 = Date.now();
    mention(handlers, ENGINEERING, '@Bob first', t0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Same conversation, mid-turn: a steer. Another conversation: not.
    mention(handlers, ENGINEERING, '@Bob and also this', t0 + 100);
    mention(handlers, DM, 'hello?', t0 + 110);

    await until(() => said.length === 3, 'three replies');
    const texts = promptTexts(record);
    const steerNote = '[new message — arrived while you were working]';
    const engineeringFollowUp = texts.find((t) => t.includes('and also this'));
    const dm = texts.find((t) => t.includes('hello?'));
    assert.ok(engineeringFollowUp?.includes(steerNote), 'the same conversation is steered');
    assert.ok(dm !== undefined && !dm.includes(steerNote), 'the DM knew nothing of the review');
  });

  it('says so where it was asked when a turn cannot start, rather than dropping the message', async () => {
    const { handlers, said, statuses } = await start(
      { FAKE_MODELS: 'fast,smart' },
      { parallelism: 2 },
      { modelId: 'opus' },
    );

    mention(handlers, DM, 'are you there?', Date.now());
    await until(() => said.length === 1, 'the refusal to be said');
    assert.equal(said[0]?.channelId, DM.id, 'in the conversation that asked');
    assert.match(said[0]?.text ?? '', /no model "opus" here/);
    assert.ok(
      statuses.some((s) => s.status.includes('opus')),
      `and the nameplate says why: ${JSON.stringify(statuses.map((s) => s.status))}`,
    );

    // Asked again in the same conversation: the nameplate already says it.
    mention(handlers, DM, 'hello??', Date.now());
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(said.length, 1, 'said once per conversation');
  });

  it('cancels a session on the agent side when it falls out of the cap', async () => {
    const rooms = [1, 2, 3, 4, 5].map(OTHER);
    const { handlers, record, said } = await start(
      { FAKE_REPLY: 'ok' },
      { parallelism: 1, channels: rooms },
    );

    // The lobby was warmed at start, so five rooms is six scopes on one
    // process with a cap of four.
    for (const [index, room] of rooms.entries()) {
      mention(handlers, room, `@Bob hi from ${room.name}`, Date.now() + index);
      await until(() => said.length === index + 1, `reply ${index + 1}`);
    }

    await until(
      () => requests(record).some((entry) => entry.method === 'session/cancel'),
      'an evicted session to be cancelled',
    );
    const cancelled = requests(record).filter((entry) => entry.method === 'session/cancel');
    const opened = requests(record).filter((entry) => entry.method === 'session/new');
    assert.ok(cancelled.length >= 2, `two fell out of a cap of four: ${cancelled.length} cancelled`);
    assert.equal(opened.length, 6, 'the lobby and five rooms');
  });

  it('says so when its runtime dies mid-turn, restarts once, and refuses the queue when it gives up', async () => {
    const { handlers, said, statuses } = await start(
      { FAKE_CRASH_AFTER: '0' },
      { parallelism: 1 },
    );

    // First crash: the turn that was running says so; the worker restarts.
    mention(handlers, DM, 'are you there?', Date.now());
    await until(() => said.length === 1, 'the failure to be said');
    assert.equal(said[0]?.channelId, DM.id, 'where it was asked');
    assert.match(said[0]?.text ?? '', /Something went wrong/);
    await until(() => statuses.at(-1)?.status === '', 'back to idle after the restart');

    // Second crash: given up on, said once aloud, and shown as offline. The
    // two lines leave in whichever order the exit and the rejected prompt
    // reach the runner, paced two seconds apart either way.
    mention(handlers, ENGINEERING, '@Bob still there?', Date.now());
    await until(() => said.length === 3, 'the second failure and the giving-up');
    const failed = said.slice(1).find((s) => s.channelId === ENGINEERING.id);
    const gaveUp = said.slice(1).find((s) => s.channelId === undefined);
    assert.match(failed?.text ?? '', /Something went wrong/, 'the turn says so where it was asked');
    assert.match(gaveUp?.text ?? '', /keeps crashing/, 'giving up is said aloud, to the room');
    await until(() => statuses.at(-1)?.status === 'offline', 'offline on the nameplate');
    assert.equal(current?.state, 'offline');

    // Nothing left to run turns on: a message is refused, not queued forever.
    mention(handlers, DM, 'hello??', Date.now());
    await until(() => said.length === 4, 'the refusal');
    assert.equal(said[3]?.channelId, DM.id);
    assert.match(said[3]?.text ?? '', /not running/);
  });

  it('cancels only the turn in the conversation !cancel was typed in', async () => {
    const { handlers, record, said } = await start(
      { FAKE_DELAY_MS: '1500', FAKE_REPLY: 'done' },
      { parallelism: 2 },
    );

    const t0 = Date.now();
    mention(handlers, ENGINEERING, '@Bob review PR 76', t0);
    mention(handlers, DM, 'and a question', t0 + 10);
    await until(() => promptTexts(record).length === 2, 'both turns to be prompted');

    handlers.channelChat?.({
      from: 'sess-josh',
      fromUserId: 'owner-1',
      fromName: 'Josh',
      fromKind: 'human',
      text: '!cancel',
      channel: DM,
      mentioned: true,
      sentAt: t0 + 20,
    });

    await until(
      () => requests(record).some((entry) => entry.method === 'session/cancel'),
      'a cancel to reach the runtime',
    );
    const promptsBySession = requests(record)
      .filter((entry) => entry.method === 'session/prompt')
      .map((entry) => ({
        session: String(entry.params?.['sessionId']),
        text: JSON.stringify(entry.params?.['prompt']),
      }));
    const dmSession = promptsBySession.find((p) => p.text.includes('and a question'))?.session;
    const reviewSession = promptsBySession.find((p) => p.text.includes('review PR 76'))?.session;
    const cancelled = requests(record)
      .filter((entry) => entry.method === 'session/cancel')
      .map((entry) => String(entry.params?.['sessionId']));
    assert.deepEqual(cancelled, [dmSession], `only the DM's session: ${JSON.stringify(cancelled)}`);
    assert.notEqual(dmSession, reviewSession);

    // The fake ignores cancellation and finishes anyway; the review still lands.
    await until(() => said.some((s) => s.channelId === ENGINEERING.id), 'the review');
  });

  it('retries !remember once when another session wrote memory first', async () => {
    const writes: Array<{ slug: string; content: string; expectedHash?: string }> = [];
    const { handlers, said } = await start(
      { FAKE_REPLY: 'ok' },
      { parallelism: 1, core: 'be kind', conflictOnce: true, writes },
    );

    aloud(handlers, '!remember answer in Portuguese');
    await until(() => writes.length === 2, 'a second attempt');
    assert.equal(writes[0]?.expectedHash, 'h-7', 'conditioned on what was read');
    assert.equal(writes[1]?.content, 'be kind\nanswer in Portuguese', 'read again, then written');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(said.length, 0, 'and nothing to apologise for');
  });

  it('tells every other session when one of them writes core memory', async () => {
    const { handlers, record, said } = await start(
      { FAKE_REPLY: 'noted', FAKE_TOOL_CALL: 'memory_set:{"slug":"core","content":"be terse"}' },
      { parallelism: 1, core: 'be kind' },
    );

    // Lobby, primed on its first turn. The turn's memory_set tells no other
    // session — there is none yet.
    aloud(handlers, '@Bob hi');
    await until(() => said.length === 1, 'the lobby reply');

    // A channel turn writes core; the lobby session must hear about it.
    mention(handlers, ENGINEERING, '@Bob hi', Date.now());
    await until(() => said.length === 2, 'the channel reply');

    aloud(handlers, '@Bob still there?');
    await until(() => said.length === 3, 'the second lobby reply');

    const texts = promptTexts(record);
    assert.equal(texts.length, 3);
    assert.match(texts[0] ?? '', /\[You\]/, 'the first lobby turn primes');
    assert.match(texts[1] ?? '', /\[You\]/, 'the channel turn primes its own session');
    assert.match(texts[2] ?? '', /\[You\]/, 'and the lobby is primed again after the write');
    assert.match(texts[2] ?? '', /be terse/, 'with what was written');
  });
});
