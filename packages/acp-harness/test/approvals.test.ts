import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  approvalHandle,
  askingMode,
  describeApproval,
  mayNeverAsk,
  pickApproval,
  summariseToolCall,
  supportedOptions,
} from '../src/runner/approvals.js';

const request = (requestId: string, toolName: string, summary = '') => ({
  request: { requestId, toolName, summary },
});

const BASH_A = request('11111111-2222-4333-8444-555555555555', 'Bash', 'git status');
const BASH_B = request('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Bash', 'rm -rf build');
const READ = request('99999999-8888-4777-8666-555555555555', 'Read');

describe('which options a card may offer', () => {
  it('offers Allow once only when the runtime offered an allow', () => {
    assert.deepEqual(
      supportedOptions([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }]),
      [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' },
      ],
    );
    assert.deepEqual(supportedOptions([{ optionId: 'r', kind: 'reject_once' }]), [
      { id: 'deny', label: 'Deny' },
    ]);
  });

  it('never offers a standing grant, even when the runtime does', () => {
    const options = supportedOptions([
      { optionId: 'a', kind: 'allow_always' },
      { optionId: 'r', kind: 'reject_always' },
    ]);
    assert.deepEqual(options.map((option) => option.id), ['allow_once', 'deny']);
  });

  it('still offers Deny when the runtime offered nothing usable', () => {
    assert.deepEqual(supportedOptions([]), [{ id: 'deny', label: 'Deny' }]);
  });
});

describe('what the card says the tool would do', () => {
  it('prefers the command the runtime supplied', () => {
    assert.equal(summariseToolCall({ rawInput: { command: 'pnpm test' } }), 'pnpm test');
  });

  it('falls back to the paths, and invents nothing when there are none', () => {
    assert.equal(
      summariseToolCall({ locations: [{ path: '/repo/src/a.ts' }, { path: '/repo/src/b.ts' }] }),
      '/repo/src/a.ts, /repo/src/b.ts',
    );
    assert.equal(summariseToolCall({ title: 'Run a thing' }), '');
    assert.equal(summariseToolCall(null), '');
  });

  it('does not repeat a path the tool name already carries', () => {
    const call = { rawInput: { file_path: '/repo/a.ts' } };
    assert.equal(summariseToolCall(call, 400, 'Write /repo/a.ts'), '', 'the name says it already');
    assert.equal(summariseToolCall(call, 400, 'Write'), '/repo/a.ts', 'but not when it does not');
  });

  it('redacts a credential somebody put on the command line', () => {
    const summary = summariseToolCall({ rawInput: { command: 'gh auth login --token ghp_abc123DEF456' } });
    assert.equal(summary.includes('ghp_abc123DEF456'), false);
    assert.ok(summary.startsWith('gh auth login'));
  });
});

describe('which open question a typed answer names', () => {
  it('answers the only one when there is only one', () => {
    assert.deepEqual(pickApproval([BASH_A], ''), { kind: 'one', approval: BASH_A });
    assert.deepEqual(pickApproval([BASH_A], 'bash'), { kind: 'one', approval: BASH_A });
  });

  it('refuses a bare yes while two are waiting', () => {
    const match = pickApproval([BASH_A, READ], '');
    assert.equal(match.kind, 'ambiguous');
    assert.equal(match.kind === 'ambiguous' && match.candidates.length, 2);
  });

  it('refuses a tool name two questions share', () => {
    const match = pickApproval([BASH_A, BASH_B], 'Bash');
    assert.equal(match.kind, 'ambiguous');
    assert.equal(match.kind === 'ambiguous' && match.candidates.length, 2);
  });

  it('tells two questions about the same tool apart by handle', () => {
    assert.deepEqual(pickApproval([BASH_A, BASH_B], `#${approvalHandle(BASH_B.request.requestId)}`), {
      kind: 'one',
      approval: BASH_B,
    });
    assert.deepEqual(pickApproval([BASH_A, BASH_B], approvalHandle(BASH_A.request.requestId)), {
      kind: 'one',
      approval: BASH_A,
    });
  });

  it('picks the one whose name matches when the other does not', () => {
    assert.deepEqual(pickApproval([BASH_A, READ], 'read'), { kind: 'one', approval: READ });
    assert.deepEqual(pickApproval([BASH_A, READ], 'rea'), { kind: 'one', approval: READ });
  });

  it('asks rather than guessing when the name matches nothing waiting', () => {
    const match = pickApproval([BASH_A, READ], 'Write');
    assert.equal(match.kind, 'ambiguous');
  });

  it('has nothing to answer when nothing is waiting', () => {
    assert.deepEqual(pickApproval([], 'Bash'), { kind: 'none' });
  });
});

describe('naming a question to a person', () => {
  it('quotes the handle and the action', () => {
    assert.equal(describeApproval(BASH_A.request), 'Bash #111111 (git status)');
    assert.equal(describeApproval(READ.request), 'Read #999999');
  });
});

/**
 * Claude Code's adapter opens sessions in `auto` and decides permissions
 * itself, so without this every approval path above was dead on the office's
 * primary runtime and the `run` scope meant nothing there.
 */
describe('making a runtime ask at all', () => {
  const claudeModes = {
    currentModeId: 'auto',
    availableModes: [
      { id: 'default', name: 'Manual' },
      { id: 'acceptEdits', name: 'Accept edits' },
      { id: 'plan', name: 'Plan' },
      { id: 'auto', name: 'Auto' },
      { id: 'bypassPermissions', name: 'Bypass permissions' },
    ],
  };

  it('moves Claude Code out of the mode that answers for itself', () => {
    assert.equal(askingMode('claude-code', claudeModes), 'default');
  });

  it('leaves a session that already asks alone', () => {
    assert.equal(askingMode('claude-code', { ...claudeModes, currentModeId: 'default' }), null);
  });

  it('does not guess a mode for a runtime whose modes are not established', () => {
    assert.equal(askingMode('codex', claudeModes), null);
    assert.equal(askingMode('opencode', claudeModes), null);
    assert.equal(mayNeverAsk('codex', claudeModes), true, 'but it says so');
    assert.equal(mayNeverAsk('claude-code', claudeModes), false);
  });

  it('asks for nothing when the runtime offers no modes', () => {
    assert.equal(askingMode('claude-code', undefined), null);
    assert.equal(askingMode('claude-code', { availableModes: [] }), null);
    assert.equal(mayNeverAsk('codex', undefined), false, 'nothing to warn about');
  });

  it('will not ask for a mode the runtime did not offer', () => {
    assert.equal(
      askingMode('claude-code', { currentModeId: 'auto', availableModes: [{ id: 'auto' }] }),
      null,
    );
  });
});
