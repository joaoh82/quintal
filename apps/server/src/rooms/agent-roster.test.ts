import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RuntimeStatus } from '@quintal/shared';
import type { AgentListEntry } from '@quintal/shared/db';

import {
  agentCardOf,
  agentChangeNote,
  agentMachineOf,
  agentMadeNote,
  parseWantedScopes,
  resolveLaunch,
  type RosterMachine,
} from './agent-roster.js';

const claude: RuntimeStatus = {
  id: 'claude-code',
  installed: true,
  path: '/usr/bin/claude',
  models: { configId: 'model', current: 'sonnet', choices: [{ id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }] },
};
const codexMissing: RuntimeStatus = { id: 'codex', installed: false, path: null };
const laptop: RosterMachine = { label: 'laptop', lastSeenAt: new Date(1_000), runtimes: [claude, codexMissing] };
const creating = { creating: true };
const changing = { creating: false };

function entry(overrides: Partial<AgentListEntry> = {}): AgentListEntry {
  return {
    id: 'a-1',
    workspaceId: 'w-1',
    name: 'Marvin',
    description: 'Reviews.',
    instructions: 'Be terse.',
    spriteKey: 'slate',
    scopes: ['chat', 'agents'],
    status: '',
    ownerUserId: 'u-josh',
    ownerName: 'Josh',
    runtimeId: 'claude-code',
    hostLabel: 'laptop',
    reportedHostLabel: null,
    modelId: null,
    maxSessions: null,
    enabled: true,
    createdByAgentId: null,
    createdByAgentName: null,
    workspacePath: '',
    pubkey: null,
    createdAt: 0,
    lastSeenAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('what an agent sees of another', () => {
  const here = new Set(['a-1']);

  it('shows its owner\'s agents whole, when asked for one', () => {
    const card = agentCardOf(entry({ createdByAgentName: 'Arthur' }), { ownerUserId: 'u-josh', here, whole: true });
    assert.equal(card.yours, true);
    assert.equal(card.here, true);
    assert.equal(card.instructions, 'Be terse.');
    assert.deepEqual(card.scopes, ['chat', 'agents']);
    assert.equal(card.madeBy, 'Arthur');
  });

  it('leaves the instructions out of a list', () => {
    assert.equal('instructions' in agentCardOf(entry(), { ownerUserId: 'u-josh', here }), false);
  });

  it('keeps somebody else\'s standing orders and scopes from it, even asked for whole', () => {
    const card = agentCardOf(entry(), { ownerUserId: 'u-ana', here, whole: true });
    assert.equal(card.yours, false);
    for (const hidden of ['instructions', 'scopes', 'enabled', 'maxSessions', 'madeBy']) {
      assert.equal(hidden in card, false, hidden);
    }
    assert.equal(card.description, 'Reviews.', 'the card line is everybody\'s');
    assert.ok(card.character.length > 0, 'and so is the body: anybody can see it');
  });
});

describe('a machine, as a model is told about it', () => {
  it('names only what is installed and can be driven, with its models', () => {
    const noAcp: RuntimeStatus = { id: 'not-in-the-catalogue', installed: true, path: '/x' };
    assert.deepEqual(agentMachineOf({ ...laptop, runtimes: [claude, codexMissing, noAcp] }), {
      label: 'laptop',
      lastSeenAt: 1_000,
      runtimes: [{ id: 'claude-code', label: 'Claude Code', models: ['sonnet', 'opus'] }],
    });
  });
});

describe('scopes, as a model names them', () => {
  it('orders them canonically and drops repeats', () => {
    assert.deepEqual(parseWantedScopes(['run', 'chat', 'chat']), { scopes: ['chat', 'run'] });
    assert.deepEqual(parseWantedScopes([]), { scopes: [] });
  });

  it('refuses a scope that does not exist rather than storing less than was asked', () => {
    const outcome = parseWantedScopes(['chat', 'deploy']);
    assert.ok('refusal' in outcome);
    assert.match(outcome.refusal, /No scope called deploy/);
    assert.ok('refusal' in parseWantedScopes('chat'));
  });
});

describe('where an agent runs', () => {
  const maker = { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: 'opus' };

  it('puts a new one beside its maker, on the runtime\'s default model', () => {
    assert.deepEqual(resolveLaunch({}, maker, [laptop], creating), {
      ok: true,
      launch: { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: null },
    });
  });

  it('leaves a new one unrun when its maker is on no machine and nobody says', () => {
    assert.deepEqual(resolveLaunch({}, { hostLabel: null, runtimeId: null, modelId: null }, [laptop], creating), { ok: true, launch: null });
  });

  it('asks for the machine when a runtime is named with nowhere to run it', () => {
    const outcome = resolveLaunch({ runtime: 'claude-code' }, { hostLabel: null, runtimeId: null, modelId: null }, [laptop], creating);
    assert.deepEqual(outcome, { ok: false, refusal: 'Say which machine. Your owner\'s are: laptop.' });
  });

  it('takes a machine and a runtime as people write them', () => {
    const outcome = resolveLaunch({ machine: 'LAPTOP', runtime: 'claude code', model: 'sonnet' }, null, [laptop], creating);
    assert.deepEqual(outcome, { ok: true, launch: { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: 'sonnet' } });
  });

  it('refuses a machine, runtime or model nothing has reported, naming what there is', () => {
    const noMachine = resolveLaunch({ machine: 'buildbox' }, maker, [laptop], creating);
    assert.ok(!noMachine.ok && /no machine called buildbox\. Theirs are: laptop/.test(noMachine.refusal));
    const notInstalled = resolveLaunch({ runtime: 'codex' }, maker, [laptop], creating);
    assert.ok(!notInstalled.ok && /cannot run Codex\. It has: claude-code/.test(notInstalled.refusal));
    const unknown = resolveLaunch({ runtime: 'hal9000' }, maker, [laptop], creating);
    assert.ok(!unknown.ok && /No runtime called hal9000/.test(unknown.refusal));
    const noModel = resolveLaunch({ model: 'gpt-9' }, maker, [laptop], creating);
    assert.ok(!noModel.ok && /It offers: sonnet, opus/.test(noModel.refusal));
  });

  it('asks nothing of a change that says nothing about where it runs', () => {
    assert.deepEqual(resolveLaunch({}, maker, [laptop], changing), { ok: true, launch: undefined });
  });

  it('takes it off its machine on null', () => {
    assert.deepEqual(resolveLaunch({ machine: null }, maker, [laptop], changing), { ok: true, launch: null });
  });

  it('keeps a model chosen for the same machine and runtime, and drops it on a move', () => {
    const elsewhere: RosterMachine = { label: 'buildbox', lastSeenAt: null, runtimes: [claude] };
    assert.deepEqual(resolveLaunch({ machine: 'laptop' }, maker, [laptop, elsewhere], changing), {
      ok: true,
      launch: { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: 'opus' },
    });
    assert.deepEqual(resolveLaunch({ machine: 'buildbox' }, maker, [laptop, elsewhere], changing), {
      ok: true,
      launch: { hostLabel: 'buildbox', runtimeId: 'claude-code', modelId: null },
    });
  });

  it('does not make a machine that stopped reporting a runtime cost the choice already made', () => {
    const quiet: RosterMachine = { label: 'laptop', lastSeenAt: null, runtimes: [] };
    assert.deepEqual(resolveLaunch({ model: 'opus' }, maker, [quiet], changing), {
      ok: true,
      launch: { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: 'opus' },
    });
  });

  it('goes back to the default model on null', () => {
    assert.deepEqual(resolveLaunch({ model: null }, maker, [laptop], changing), {
      ok: true,
      launch: { hostLabel: 'laptop', runtimeId: 'claude-code', modelId: null },
    });
  });
});

describe('what the agent is told happens next', () => {
  it('says plainly when nothing will run a new agent', () => {
    assert.match(agentMadeNote('Bob', 'laptop'), /starts on laptop/);
    assert.match(agentMadeNote('Bob', null), /nothing runs it yet/);
  });

  it('warns of a restart only for what restarts it', () => {
    assert.match(agentChangeNote('Bob', ['instructions'], 'laptop', true), /restarts on laptop.*cut short/);
    const scopesOnly = agentChangeNote('Bob', ['scopes'], 'laptop', true);
    assert.doesNotMatch(scopesOnly, /restarts/);
    const lookOnly = agentChangeNote('Bob', ['character'], 'laptop', true);
    assert.match(lookOnly, /no restart/);
    assert.doesNotMatch(lookOnly, /restarts on/);
    assert.match(scopesOnly, /next session/);
  });

  it('does not promise a restart of something switched off or on no machine', () => {
    assert.doesNotMatch(agentChangeNote('Bob', ['enabled', 'instructions'], 'laptop', false), /restarts/);
    assert.match(agentChangeNote('Bob', ['instructions'], null, true), /next time it is started/);
    assert.match(agentChangeNote('Bob', ['machine'], null, true), /nothing runs it until it is given one/);
  });
});
