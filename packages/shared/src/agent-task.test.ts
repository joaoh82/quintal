import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Decoder, Encoder } from '@colyseus/schema';

import {
  AGENT_TASK_TITLE_MAX,
  agentTaskFields,
  agentTaskOf,
  parseAgentTask,
} from './agent-task.js';
import { OfficeState, createPlayer } from './game/state.js';

/**
 * `agent:task` is drawn on a card every viewer sees, from a payload a harness
 * wrote. These pin what gets through: the shape the harness sends, `null` as
 * the one way to say "no task", and nothing else — least of all a link that is
 * not a web page.
 */

const TASK = {
  title: 'fix the login redirect',
  repo: 'api',
  branch: 'quintal/marvin/fix-the-login-redirect',
  pr: { number: 12, url: 'https://github.com/acme/api/pull/12', state: 'open' as const },
};

describe('the agent:task payload', () => {
  it('takes a task with its pull request', () => {
    assert.deepEqual(parseAgentTask(TASK), TASK);
  });

  it('takes a task with no pull request yet', () => {
    const { pr: _pr, ...bare } = TASK;
    assert.deepEqual(parseAgentTask(bare), bare);
    assert.deepEqual(parseAgentTask({ ...bare, pr: null }), bare, 'a null pr is no pr');
  });

  it('reads null as "no task", which is not the same as garbage', () => {
    assert.equal(parseAgentTask(null), null);
    assert.equal(parseAgentTask(undefined), undefined);
  });

  it('takes the state as gh says it, and sends it on in lower case', () => {
    assert.equal(parseAgentTask({ ...TASK, pr: { ...TASK.pr, state: 'MERGED' } })?.pr?.state, 'merged');
  });

  it('takes a repo in a group', () => {
    assert.equal(parseAgentTask({ ...TASK, repo: 'group/api' })?.repo, 'group/api');
  });

  it('refuses garbage rather than reading it as a clear', () => {
    const garbage: unknown[] = [
      'fix the login redirect',
      42,
      [],
      [TASK],
      {},
      { ...TASK, title: '' },
      { ...TASK, title: '   ' },
      { ...TASK, title: 7 },
      { ...TASK, repo: undefined },
      { ...TASK, repo: '' },
      { ...TASK, branch: 'has a space' },
      { ...TASK, branch: 'x'.repeat(201) },
      { ...TASK, branch: 'line\nbreak' },
      { ...TASK, pr: 'https://github.com/acme/api/pull/12' },
      { ...TASK, pr: { ...TASK.pr, number: 0 } },
      { ...TASK, pr: { ...TASK.pr, number: 1.5 } },
      { ...TASK, pr: { ...TASK.pr, number: '12' } },
      { ...TASK, pr: { ...TASK.pr, state: 'draft' } },
      { ...TASK, pr: { ...TASK.pr, url: 'not a url' } },
    ];
    for (const value of garbage) {
      assert.equal(parseAgentTask(value), undefined, JSON.stringify(value));
    }
  });

  it('refuses a link that is not a web page', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      assert.equal(parseAgentTask({ ...TASK, pr: { ...TASK.pr, url } }), undefined, url);
    }
  });

  it('clips a long title instead of refusing it, and keeps it on one line', () => {
    const parsed = parseAgentTask({ ...TASK, title: `fix\nthe\u0007 ${'a'.repeat(400)}` });
    assert.ok(parsed);
    assert.ok(parsed.title.length <= AGENT_TASK_TITLE_MAX);
    assert.ok(parsed.title.startsWith('fix the a'), parsed.title);
  });

  it('keeps nothing it was not asked for', () => {
    const parsed = parseAgentTask({ ...TASK, worktree: '/home/someone/secret', pr: { ...TASK.pr, headRefOid: 'abc' } });
    assert.deepEqual(parsed, TASK);
  });
});

describe('the task in room state', () => {
  it('reads back what was written, and null as every field blank', () => {
    assert.deepEqual(agentTaskOf(agentTaskFields(TASK)), TASK);
    assert.equal(agentTaskOf(agentTaskFields(null)), null);
    const { pr: _pr, ...bare } = TASK;
    assert.deepEqual(agentTaskOf(agentTaskFields(bare)), bare);
  });

  it('reaches a client that decodes the room', () => {
    const state = new OfficeState();
    const player = createPlayer({ userId: 'agent-1', name: 'Marvin', x: 0, y: 0, kind: 'agent' });
    Object.assign(player, agentTaskFields(TASK));
    state.players.set('s1', player);

    const decoded = new OfficeState();
    new Decoder(decoded).decode(new Encoder(state).encodeAll());
    assert.deepEqual(agentTaskOf(decoded.players.get('s1')!), TASK);
  });
});
