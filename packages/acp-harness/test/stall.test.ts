import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner, describeSpan } from '../src/runner/AgentRunner.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * A turn the runtime goes silent on.
 *
 * OpenRouter dropped the socket seven minutes into one review and hung for
 * twelve on the next, and both times the nameplate said "thinking" until
 * the owner typed `!cancel`. The harness had no notion of a turn that had
 * stopped moving. Now it does: with no chunk, no thought and no tool call
 * for the idle allowance, the turn is stopped and the person waiting is
 * told why. A turn that is merely slow, but alive, is left alone.
 */

interface Handlers {
  chat?: (message: unknown) => void;
  channelChat?: (message: unknown) => void;
}

const ENGINEERING = { id: 'ch-eng', kind: 'channel', name: 'Engineering', slug: 'engineering' };

type Said = Array<{ text: string; channelId: string | undefined; at: number }>;

function fakeGateway(handlers: Handlers, said: Said): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: 'owner-1',
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes: ['chat', 'status'],
    channels: [ENGINEERING],
    limits: { walkUpRadiusTiles: 4 },
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push({ text, channelId, at: Date.now() });
    },
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '', hash: 'h-0' }),
    memorySet: async () => ({ ok: true }),
    occupants: () => [],
    channels: () => [ENGINEERING],
    on: (event: string, handler: unknown) => {
      (handlers as Record<string, unknown>)[event] = handler;
    },
  } as unknown as Gateway;
}

function config(cwd: string): AgentConfig {
  return {
    name: 'Bob',
    key: 'agent-key',
    hostToken: '',
    agentId: '',
    harness: 'custom',
    command: [process.execPath, FAKE],
    cwd,
    url: 'http://localhost:0',
    mapId: 'hq',
    workspaceId: 'ws-1',
  } as unknown as AgentConfig;
}

async function until(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function mention(handlers: Handlers, text: string): void {
  handlers.channelChat?.({
    from: 'sess-josh',
    fromUserId: 'owner-1',
    fromName: 'Josh',
    fromKind: 'human',
    text,
    channel: ENGINEERING,
    mentioned: true,
    sentAt: Date.now(),
  });
}

describe('a turn the runtime goes silent on', () => {
  let current: AgentRunner | null = null;
  const ENV = ['FAKE_DELAY_MS', 'FAKE_HEARTBEAT_MS', 'FAKE_PERMISSION', 'QUINTAL_TURN_IDLE_MS'] as const;
  const previous: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  for (const key of ENV) previous[key] = process.env[key];

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
  }

  after(async () => {
    await stopCurrent();
    for (const key of ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  async function start(env: Partial<Record<(typeof ENV)[number], string>>) {
    await stopCurrent();
    // Only what this case asks for: a switch left on by the last case would
    // make the fake do something the assertions never mention.
    for (const key of ENV) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const handlers: Handlers = {};
    const said: Said = [];
    current = new AgentRunner(
      config(mkdtempSync(join(tmpdir(), 'quintal-stall-'))),
      undefined,
      fakeGateway(handlers, said),
    );
    await current.start();
    return { handlers, said };
  }

  it('is stopped, and the person waiting is told why, where they asked', async () => {
    // The fake pauses for three seconds mid-turn and sends nothing while it
    // does. The allowance is half a second.
    const { handlers, said } = await start({ FAKE_DELAY_MS: '3000', QUINTAL_TURN_IDLE_MS: '500' });

    const asked = Date.now();
    mention(handlers, '@Bob review PR 34');
    await until(() => said.some((s) => /said nothing for 500 ms/.test(s.text)), 'the stall notice');

    const notice = said.find((s) => /said nothing/.test(s.text))!;
    assert.equal(notice.channelId, ENGINEERING.id, 'said in the channel the review was asked in');
    assert.ok(notice.at - asked < 2_500, 'well before the runtime would have answered on its own');
    assert.match(notice.text, /Ask again and I will start over/);
    // The fake ignores session/cancel and finishes on its own clock; a real
    // runtime returns the prompt as cancelled at once. Either way the turn
    // ends and the nameplate stops saying "thinking".
    await until(() => current?.state === 'connected', 'the turn to end', 6_000);
  });

  it('leaves a slow but living turn alone', async () => {
    const { handlers, said } = await start({ FAKE_DELAY_MS: '300', QUINTAL_TURN_IDLE_MS: '5000' });

    mention(handlers, '@Bob review PR 34');
    await until(() => said.some((s) => s.text === 'ok'), 'the reply');

    assert.equal(said.filter((s) => /said nothing/.test(s.text)).length, 0, 'no stall notice');
  });

  it('is kept alive by thoughts: every update restarts the clock', async () => {
    // Silent, this pause is three times the allowance. Thinking aloud every
    // 150 ms, it is a slow model, and the clock never runs out.
    const { handlers, said } = await start({
      FAKE_DELAY_MS: '1500',
      FAKE_HEARTBEAT_MS: '150',
      QUINTAL_TURN_IDLE_MS: '500',
    });

    mention(handlers, '@Bob review PR 34');
    await until(() => said.some((s) => s.text === 'ok'), 'the reply', 6_000);

    assert.equal(said.filter((s) => /said nothing/.test(s.text)).length, 0, 'no stall notice');
  });

  it('waits with the owner on a tool-approval question rather than calling it silence', async () => {
    // The fake asks before replying. Nobody has the run scope here, so the
    // question goes to the owner — and the owner takes three times the idle
    // allowance to answer.
    const { handlers, said } = await start({ FAKE_PERMISSION: 'Bash', QUINTAL_TURN_IDLE_MS: '500' });

    mention(handlers, '@Bob review PR 34');
    await until(() => said.some((s) => /may I run Bash/.test(s.text)), 'the question');
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(said.filter((s) => /said nothing/.test(s.text)).length, 0, 'the owner is thinking, not the model');
    assert.equal(current?.state, 'working', 'still waiting on the owner');

    mention(handlers, '@Bob yes Bash');
    await until(() => said.some((s) => s.text === 'ok'), 'the reply once the owner answered');
    assert.equal(said.filter((s) => /said nothing/.test(s.text)).length, 0);
  });
});

describe('how a span is said', () => {
  it('uses the unit a person would', () => {
    assert.equal(describeSpan(300_000), '5 minutes');
    assert.equal(describeSpan(60_000), '1 minute');
    assert.equal(describeSpan(30_000), '30 seconds');
    assert.equal(describeSpan(1_000), '1 second');
    assert.equal(describeSpan(500), '500 ms');
  });
});
