import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_MAX_BYTES, parseActivity, type AgentActivity } from '@quintal/shared';
import { PublicTurn, toolOutcome } from '../src/runner/activity.js';

test('nonzero exit with no error is failed; absent results never imply success', () => {
  assert.equal(
    toolOutcome({
      status: 'completed',
      rawOutput: { exit_code: 1, error: null },
    }),
    'failed',
  );
  assert.equal(toolOutcome({ status: 'completed', rawOutput: { exitCode: 0 } }), 'success');
  assert.equal(toolOutcome({ status: 'completed' }), 'unknown');
  assert.equal(toolOutcome({ status: 'completed', rawOutput: {} }), 'unknown');
  assert.equal(
    toolOutcome({
      status: 'completed',
      rawOutput: { error: null, metadata: {} },
    }),
    'unknown',
  );
});
test('narration, three command results and replies retain order and identities', () => {
  const sent: AgentActivity[] = [];
  const turn = new PublicTurn({ channelId: 'a' }, (value) => sent.push(value));
  assert.equal(sent[0]?.state, 'queued');
  turn.text('Checking the machine.');
  for (const [index, command] of ['ls .', 'uname -a', 'false'].entries()) {
    const toolCallId = `call-${index}`;
    turn.tool({ toolCallId, title: command, status: 'in_progress' });
    turn.flush();
    assert.equal(sent.at(-1)?.items.at(-1)?.state, 'running');
    turn.tool({
      toolCallId,
      status: 'completed',
      rawOutput: { exit_code: index === 2 ? 1 : 0, error: null },
    });
  }
  turn.text('Two succeeded; false failed.');
  turn.finish('completed');
  const last = sent.at(-1)!;
  assert.deepEqual(
    last.items.map((i) => i.state),
    ['success', 'success', 'success', 'failed', 'success'],
  );
  assert.equal(last.items[0]?.text, 'Checking the machine.');
  assert.equal(new Set(last.items.map((i) => i.id)).size, last.items.length);
  assert.ok(last.items.every((i) => i.endedAt !== undefined));
  assert.ok(sent.some((v) => v.items.some((i) => i.kind === 'tool') && v.state !== 'completed'));
});
test('partial and out-of-order patches merge once, failure wins, late events are ignored', () => {
  const turn = new PublicTurn({ channelId: 'a' }, () => {});
  turn.tool({
    toolCallId: 'one',
    status: 'completed',
    rawOutput: { exitCode: 1 },
  });
  turn.tool({ toolCallId: 'one', title: 'false', status: 'in_progress' });
  assert.equal(turn.value.items.length, 1);
  assert.equal(turn.value.items[0]?.state, 'failed');
  turn.finish('failed');
  turn.text('late');
  turn.tool({ toolCallId: 'late' });
  assert.equal(turn.value.items.length, 1);
});
test('say and identical final text reconcile; separate turns never share item identities', () => {
  const a = new PublicTurn({ channelId: 'a' }, () => {});
  const b = new PublicTurn({ channelId: 'b' }, () => {});
  a.say('Done.');
  a.text('Done.');
  a.finish('completed');
  b.text('Other conversation');
  b.finish('completed');
  assert.equal(a.value.items.length, 1);
  assert.notEqual(a.value.turnId, b.value.turnId);
  assert.notEqual(a.value.items[0]?.id, b.value.items[0]?.id);
});
test('coalesces streaming bursts, bounds retained payload, and closes unfinished tools', async () => {
  const sent: AgentActivity[] = [];
  const turn = new PublicTurn({}, (value) => sent.push(value));
  for (let i = 0; i < 100; i++) turn.text('hello ');
  assert.equal(sent.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, 2);
  for (let i = 0; i < 100; i++) {
    turn.tool({
      toolCallId: `t${i}`,
      title: 'run',
      rawInput: { command: 'x'.repeat(4000) },
    });
  }
  turn.finish('cancelled');
  assert.ok(turn.value.items.length <= 64);
  assert.ok(new TextEncoder().encode(JSON.stringify(turn.value)).length <= ACTIVITY_MAX_BYTES);
  assert.ok(parseActivity(turn.value));
  assert.ok(turn.value.items.every((i) => i.state === 'cancelled'));
});

test('fragmented runtime notices are withheld while public narration still streams', () => {
  const sent: AgentActivity[] = [];
  const turn = new PublicTurn({}, (value) => sent.push(value));
  turn.text('War');
  turn.flush();
  turn.text('ning: internal adapter notice');
  turn.flush();
  assert.equal(sent.at(-1)?.items.length, 0);
  turn.text('\n\nPublic reply.');
  turn.finish('completed');
  assert.equal(turn.value.items[0]?.text, 'Public reply.');
});

test('captured installed ACP runtimes report the three command outcomes correctly', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const runtime of ['claude', 'codex', 'opencode', 'omp']) {
    const fixture = JSON.parse(
      await readFile(new URL(`./fixtures/activity/${runtime}.json`, import.meta.url), 'utf8'),
    );
    const turn = new PublicTurn({}, () => {});
    for (const update of fixture.updates) turn.tool(update);
    turn.finish('completed');
    const steps = turn.value.items.filter((item) => item.kind === 'tool');
    assert.equal(steps.length, 3, runtime);
    assert.ok(
      steps.some((step) => step.detail?.includes('fixture.txt')),
      runtime,
    );
    assert.equal(steps.filter((step) => step.state === 'success').length, 2, runtime);
    assert.equal(steps.filter((step) => step.state === 'failed').length, 1, runtime);
  }
});

test('a result arriving after a completed patch resolves unknown without restarting the tool', () => {
  const turn = new PublicTurn({}, () => {});
  turn.tool({ toolCallId: 'partial', status: 'completed' });
  assert.equal(turn.value.items[0]?.state, 'unknown');
  turn.tool({ toolCallId: 'partial', rawOutput: { stdout: 'result' } });
  assert.equal(turn.value.items[0]?.state, 'success');
  turn.finish('completed');
});

test('public progress carries bounded human correlation without reusing it as a turn ID', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const turn = new PublicTurn({}, () => {}, id);
  assert.equal(turn.value.requestId, id);
  assert.notEqual(turn.value.turnId, id);
  turn.finish('completed');
  const invalid = new PublicTurn({}, () => {}, 'private-content');
  assert.equal(invalid.value.requestId, invalid.value.turnId);
  invalid.finish('completed');
});
