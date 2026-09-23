import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import type { ApprovalRequest, ApprovalResolved } from '@quintal/shared';

import type { Gateway } from '../src/gateway/client.js';
import { AgentRunner } from '../src/runner/AgentRunner.js';
import { approvalHandle } from '../src/runner/approvals.js';
import type { AgentConfig } from '../src/config.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/**
 * The runtime's own "may I run this tool?" question.
 *
 * It used to be said aloud beside the agent no matter where the turn came
 * from, so an owner reading a channel never saw it, and the two-minute
 * silence that followed reached the model as "declined twice by the user".
 * The review it was asked for died on that. These pin the two ways out: the
 * `run` scope, which has the harness answer on the owner's behalf, and a
 * question that goes where the owner actually is.
 */

interface Handlers {
  ready?: (payload: unknown) => void;
  chat?: (message: unknown) => void;
  mention?: (message: unknown) => void;
  channelChat?: (message: unknown) => void;
  error?: (error: unknown) => void;
  closed?: (code: unknown) => void;
  approvalDecision?: (decision: unknown) => void;
}

const OWNER = 'owner-1';
const ENGINEERING = { id: 'ch-1', kind: 'channel', name: 'Engineering', slug: 'engineering' };
const DESIGN = { id: 'ch-2', kind: 'channel', name: 'Design', slug: 'design' };

/** What the office was told about approvals, in the order it was told. */
interface Cards {
  requested: ApprovalRequest[];
  resolved: ApprovalResolved[];
}

function fakeGateway(
  handlers: Handlers,
  said: Array<[string, string | undefined]>,
  scopes: string[],
  cards: Cards,
): Gateway {
  const ready = {
    agentId: 'agent-1',
    name: 'Bob',
    ownerUserId: OWNER,
    ownerName: 'Josh',
    description: '',
    instructions: '',
    scopes,
    channels: [ENGINEERING, DESIGN],
    limits: { walkUpRadiusTiles: 4, parallelism: 2 },
    approvalVersion: 1 as const,
  };
  return {
    ready,
    roster: { zone: { id: 'lobby', label: 'the lobby' } },
    connected: true,
    connect: async () => ready,
    leave: async () => {},
    say: (text: string, channelId?: string) => {
      said.push([text, channelId]);
    },
    setStatus: () => {},
    emote: () => {},
    hostReport: () => {},
    moveToZone: () => {},
    lookAround: async () => ({}),
    messagesGet: async () => ({ messages: [] }),
    memoryGet: async () => ({ content: '' }),
    memorySet: async () => ({ ok: true }),
    occupants: () => [],
    channels: () => [ENGINEERING, DESIGN],
    approvalRequest: (value: ApprovalRequest) => {
      cards.requested.push(value);
    },
    approvalResolved: (value: ApprovalResolved) => {
      cards.resolved.push(value);
    },
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

let clock = Date.now();

function inChannel(text: string, fromUserId = OWNER, channel = ENGINEERING) {
  clock += 1_000;
  return {
    channel,
    from: 's-1',
    fromUserId,
    fromName: fromUserId === OWNER ? 'Josh' : 'Sam',
    fromKind: 'human',
    text,
    sentAt: clock,
    mentioned: true,
  };
}

function walkUp(text: string, fromUserId = OWNER) {
  clock += 1_000;
  return {
    fromUserId,
    fromName: 'Josh',
    fromKind: 'human' as const,
    text,
    distance: 1,
    sentAt: clock,
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

describe('the runtime asks before running a tool', () => {
  let current: AgentRunner | null = null;
  let previousPermission: string | undefined;
  let previousCommand: string | undefined;

  before(() => {
    // The fake agent asks for "Bash" before every reply.
    previousPermission = process.env.FAKE_PERMISSION;
    previousCommand = process.env.FAKE_PERMISSION_COMMAND;
    process.env.FAKE_PERMISSION = 'Bash';
    process.env.FAKE_PERMISSION_COMMAND = 'pnpm build';
  });

  async function stopCurrent(): Promise<void> {
    const runner = current;
    current = null;
    await runner?.stop();
  }

  after(async () => {
    await stopCurrent();
    if (previousPermission === undefined) delete process.env.FAKE_PERMISSION;
    else process.env.FAKE_PERMISSION = previousPermission;
    if (previousCommand === undefined) delete process.env.FAKE_PERMISSION_COMMAND;
    else process.env.FAKE_PERMISSION_COMMAND = previousCommand;
  });

  async function run(scopes: string[]) {
    await stopCurrent();
    const handlers: Handlers = {};
    const said: Array<[string, string | undefined]> = [];
    const cards: Cards = { requested: [], resolved: [] };
    const logDir = mkdtempSync(join(tmpdir(), 'perm-log-'));
    const runner = new AgentRunner(
      config(mkdtempSync(join(tmpdir(), 'perm-cwd-'))),
      logDir,
      fakeGateway(handlers, said, scopes, cards),
    );
    current = runner;
    await runner.start();
    const decisions = () => {
      const path = join(logDir, 'Bob.jsonl');
      if (!existsSync(path)) return [] as Array<{ tool: string; decision: string }>;
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { kind: string; tool?: string; decision?: string })
        .filter((entry) => entry.kind === 'permission')
        .map((entry) => ({ tool: entry.tool ?? '', decision: entry.decision ?? '' }));
    };
    const asked = () => said.filter(([text]) => /may I run/.test(text));
    const decideCard = (requestId: string, optionId: 'allow_once' | 'deny') =>
      handlers.approvalDecision?.({
        requestId,
        optionId,
        decidedByUserId: OWNER,
        decidedByName: 'Josh',
      });
    return { handlers, said, decisions, asked, cards, decideCard, runner };
  }

  it('is answered by the harness when the agent has the run scope, and logged', async () => {
    const { handlers, decisions, asked, said, cards } = await run(['chat', 'run']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => decisions().length > 0, 'the decision to be logged');

    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'allowed by the run scope' }]);
    assert.equal(asked().length, 0, 'nobody was asked');
    assert.equal(cards.requested.length, 0, 'no card interrupts anybody');
    // It is still an authorization decision, so the office still hears about
    // it — as an outcome with no question attached.
    assert.deepEqual(
      cards.resolved.map((value) => [value.resolution, value.via]),
      [['auto_allowed', 'run_scope']],
    );
    await until(() => said.some(([text]) => text === 'ok'), 'the turn to finish');
  });

  it('goes to the owner in the channel the turn came from, and takes yes from there', async () => {
    const { handlers, decisions, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');

    const [question, channelId] = asked()[0]!;
    assert.equal(channelId, ENGINEERING.id, 'asked in the channel, not aloud');
    assert.match(question, /^@Josh may I run Bash/, 'the owner is mentioned');
    assert.match(question, /Use the card/);
    assert.match(question, /@Bob yes #/);

    handlers.channelChat?.(inChannel('@Bob yes'));
    await until(() => decisions().length > 0, 'the answer to land');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'once' }]);
  });

  it('sends a card with the tool, the action, and only the options it can honour', async () => {
    const { handlers, cards, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');

    const card = cards.requested[0]!;
    assert.equal(card.version, 1);
    assert.equal(card.toolName, 'Bash');
    assert.equal(card.summary, 'pnpm build', 'the command, not a guess from the title');
    assert.equal(card.channelId, ENGINEERING.id, 'in the conversation the turn came from');
    assert.equal(card.zoneId, undefined);
    assert.deepEqual(
      card.options.map((option) => option.id),
      ['allow_once', 'deny'],
      'no standing grant until QUIN-53 can explain one',
    );
    assert.ok(card.expiresAt > card.askedAt, 'the deadline is on the card');
    assert.ok(card.requestId.length > 0);
    // The sentence is still said, so an older client is not left silent.
    assert.equal(asked().length, 1);
  });

  it('is answered by the card, by request id', async () => {
    const { handlers, cards, decisions, decideCard } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');

    decideCard(cards.requested[0]!.requestId, 'allow_once');
    await until(() => decisions().length > 0, 'the answer to land');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'once' }]);
    assert.deepEqual(
      cards.resolved.map((value) => [value.resolution, value.via, value.optionId]),
      [['allowed', 'card', 'allow_once']],
    );
  });

  it('ignores a decision for a request that is no longer waiting', async () => {
    const { handlers, cards, decisions, decideCard } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');
    const { requestId } = cards.requested[0]!;

    decideCard(requestId, 'deny');
    await until(() => decisions().length > 0, 'the answer to land');
    const before = cards.resolved.length;

    // A replayed or forged second answer: the question is gone, so it is a
    // no-op rather than a second decision about the same tool call.
    decideCard(requestId, 'allow_once');
    decideCard('not-a-request-we-minted', 'allow_once');
    await settle();
    assert.equal(cards.resolved.length, before, 'nothing was resolved twice');
    assert.equal(decisions().length, 1);
  });

  it('keeps two questions about the same tool in different conversations apart', async () => {
    const { handlers, cards, decisions, decideCard } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length === 1, 'the first card');
    handlers.channelChat?.(inChannel('@Bob check it here too', OWNER, DESIGN));
    await until(() => cards.requested.length === 2, 'the second card');

    const [first, second] = cards.requested as [ApprovalRequest, ApprovalRequest];
    assert.notEqual(first.requestId, second.requestId, 'two asks, two identities');
    assert.equal(first.toolName, second.toolName, 'and the same tool name');
    assert.notEqual(first.channelId, second.channelId);

    // Answering the second must not touch the first.
    decideCard(second.requestId, 'allow_once');
    await until(() => cards.resolved.length === 1, 'the second to resolve');
    assert.equal(cards.resolved[0]!.requestId, second.requestId);
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'once' }]);

    decideCard(first.requestId, 'deny');
    await until(() => cards.resolved.length === 2, 'the first to resolve');
    assert.equal(cards.resolved[1]!.requestId, first.requestId);
    assert.equal(cards.resolved[1]!.resolution, 'denied');
  });

  it('asks which one rather than guessing when the words do not say', async () => {
    const { handlers, cards, decisions, said } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length === 1, 'the first card');
    handlers.channelChat?.(inChannel('@Bob check it here too', OWNER, DESIGN));
    await until(() => cards.requested.length === 2, 'the second card');

    // A bare "yes" with two open used to authorise the oldest.
    handlers.channelChat?.(inChannel('@Bob yes'));
    await until(
      () => said.some(([text]) => /does not say which/.test(text)),
      'the request for specificity',
    );
    await settle();
    assert.equal(decisions().length, 0, 'and nothing was authorised');

    // Naming the tool does not help when both are that tool.
    handlers.channelChat?.(inChannel('@Bob yes Bash'));
    await settle();
    assert.equal(decisions().length, 0);

    // The handle does.
    const wanted = cards.requested[1]!;
    handlers.channelChat?.(inChannel(`@Bob yes #${approvalHandle(wanted.requestId)}`));
    await until(() => decisions().length > 0, 'the handle to settle it');
    assert.equal(cards.resolved[0]!.requestId, wanted.requestId);
    assert.equal(cards.resolved[0]!.via, 'text');
  });

  it('resolves the card when the owner cancels the turn', async () => {
    const { handlers, cards, decisions } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');

    handlers.channelChat?.(inChannel('!cancel'));
    await until(() => cards.resolved.length > 0, 'the card to come down');
    assert.equal(cards.resolved[0]!.resolution, 'cancelled');
    assert.equal(cards.resolved[0]!.requestId, cards.requested[0]!.requestId);
    await until(() => decisions().length > 0, 'the runtime to be told no');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'deny' }]);
  });

  it('resolves the card when the runtime crashes under it', async () => {
    process.env.FAKE_CRASH_ON_PERMISSION = '1';
    try {
      const { handlers, cards } = await run(['chat']);
      handlers.channelChat?.(inChannel('@Bob check the build'));
      await until(() => cards.requested.length > 0, 'the card');
      await until(() => cards.resolved.length > 0, 'the card to come down with the process');
      assert.equal(cards.resolved[0]!.resolution, 'interrupted');
      assert.equal(cards.resolved[0]!.requestId, cards.requested[0]!.requestId);
    } finally {
      delete process.env.FAKE_CRASH_ON_PERMISSION;
    }
  });

  it('says the open questions again after a reconnect, and the closed ones too', async () => {
    const { handlers, cards, decideCard } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');
    const { requestId } = cards.requested[0]!;

    // The socket drops and comes back. The office that comes back knows
    // nothing, so the question has to be said again or it is invisible.
    handlers.closed?.(1006);
    await until(() => cards.requested.length > 1, 'the card to be sent again');
    assert.equal(cards.requested[1]!.requestId, requestId, 'the same question, not a new one');

    // And once it is answered, the answer is replayed too, so a card is
    // never left offering buttons that would land nowhere.
    decideCard(requestId, 'deny');
    await until(() => cards.resolved.length > 0, 'the answer');
    const settled = cards.resolved.length;
    handlers.closed?.(1006);
    await until(() => cards.resolved.length > settled, 'the answer to be sent again');
    assert.equal(cards.resolved.at(-1)!.requestId, requestId);
  });

  it('resolves the card when the agent shuts down under it', async () => {
    const { handlers, cards, runner } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => cards.requested.length > 0, 'the card');

    await runner.stop();
    assert.equal(cards.resolved.length, 1, 'the card did not outlive the agent');
    assert.equal(cards.resolved[0]!.resolution, 'cancelled');
  });

  it('takes "always" as a standing approval — the documented text fallback', async () => {
    const { handlers, decisions, asked } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');
    handlers.channelChat?.(inChannel('@Bob always'));
    await until(() => decisions().length > 0, 'the answer to land');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'always' }]);
  });

  it('asks aloud when the turn was a walk-up', async () => {
    const { handlers, asked, cards } = await run(['chat']);

    handlers.chat?.(walkUp('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');
    assert.equal(asked()[0]![1], undefined, 'said aloud, where the owner is standing');
    await until(() => cards.requested.length > 0, 'the card');
    assert.equal(cards.requested[0]!.zoneId, 'lobby', 'the card belongs to the room');
    assert.equal(cards.requested[0]!.channelId, undefined);

    handlers.chat?.(walkUp('@Bob no'));
  });

  it('only the owner may answer', async () => {
    const { handlers, decisions, asked, cards } = await run(['chat']);

    handlers.channelChat?.(inChannel('@Bob check the build'));
    await until(() => asked().length > 0, 'the question');

    handlers.channelChat?.(inChannel('@Bob yes', 'somebody-else'));
    await settle();
    assert.equal(decisions().length, 0, 'a stranger saying yes changes nothing');
    assert.equal(cards.resolved.length, 0, 'and the card is still waiting');

    handlers.channelChat?.(inChannel('@Bob no'));
    await until(() => decisions().length > 0, 'the owner to answer');
    assert.deepEqual(decisions(), [{ tool: 'Bash', decision: 'deny' }]);
  });
});
