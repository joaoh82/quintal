import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { runtimeIdOf } from '../src/config.js';
import {
  approvalHandle,
  askingMode,
  chooseRuntimeOption,
  describeApproval,
  mayNeverAsk,
  pickAllow,
  pickApproval,
  summariseToolCall,
  supportedOptions,
} from '../src/runner/approvals.js';

/**
 * The real payloads, not invented ones.
 *
 * Every claim in the catalogue was made against a runtime that was actually
 * running, so the tests are run against what those runtimes actually sent.
 * An adapter that changes its option ids should break these, loudly.
 */
const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/runtime-options.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, { options: Array<{ optionId: string; kind: string }> }>>;

const offered = (runtime: string, probe: string) => FIXTURES[runtime]![probe]!.options;

const request = (requestId: string, toolName: string, summary = '') => ({
  request: { requestId, toolName, summary },
});

const BASH_A = request('11111111-2222-4333-8444-555555555555', 'Bash', 'git status');
const BASH_B = request('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'Bash', 'rm -rf build');
const READ = request('99999999-8888-4777-8666-555555555555', 'Read');

describe('which options a card may offer', () => {
  it('offers the allow Claude Code actually sent, named for what it grants', () => {
    // "Yes" and "Yes, allow all edits in <dir>/ during this session". The
    // narrower one wins, and the button says "Allow once" because that is
    // what taking it does.
    assert.deepEqual(supportedOptions('claude-code', offered('claude-code', 'edit-in-manual-mode')), [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ]);
  });

  it('never offers a standing grant while a per-call one is on the table', () => {
    const options = supportedOptions('omp', offered('omp', 'shell'));
    assert.deepEqual(options, [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ]);
    assert.equal(pickAllow('omp', offered('omp', 'shell'))?.optionId, 'allow_once');
  });

  it('offers Deny alone when the only allow is an unmeasured "always"', () => {
    // A runtime nobody has probed, offering nothing but a standing grant.
    // "We cannot tell you what Allow would do here" is the honest answer.
    assert.deepEqual(
      supportedOptions('some-new-runtime', [
        { optionId: 'a', kind: 'allow_always' },
        { optionId: 'r', kind: 'reject_once' },
      ]),
      [{ id: 'deny', label: 'Deny' }],
    );
  });

  it('still allows once on a runtime nobody has catalogued', () => {
    // `allow_once` is read from the protocol, not guessed: an unprobed CLI
    // stays usable without anybody claiming to know what "always" means on it.
    assert.deepEqual(
      supportedOptions('some-new-runtime', [
        { optionId: 'a', kind: 'allow_once' },
        { optionId: 'b', kind: 'allow_always' },
        { optionId: 'r', kind: 'reject_once' },
      ]),
      [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' },
      ],
    );
  });

  it('still offers Deny when the runtime offered nothing usable', () => {
    assert.deepEqual(supportedOptions('claude-code', []), [{ id: 'deny', label: 'Deny' }]);
  });

});

describe('which runtime option an answer actually takes', () => {
  it('takes the narrowest allow, not the first of its kind', () => {
    // The bug this ticket exists for. Reading the ACP kind and taking the
    // first `allow_always` on a plan-exit request selects "clear context and
    // use auto mode" — a standing grant *and* a discarded conversation.
    const plan = offered('claude-code', 'exit-plan-mode');
    assert.equal(plan.find((option) => option.kind === 'allow_always')?.optionId, 'exit-plan-clear-auto');
    assert.equal(chooseRuntimeOption('claude-code', plan, 'once').optionId, 'exit-plan-default');
    assert.equal(chooseRuntimeOption('claude-code', plan, 'always').optionId, 'exit-plan-default');
  });

  it('never lets the run scope take anything broader than the one call', () => {
    const plan = offered('claude-code', 'exit-plan-mode');
    const automatic = chooseRuntimeOption('claude-code', plan, 'once', true);
    // Every option on a plan-exit request changes the session's policy, so
    // there is no per-call answer to give and the runtime is cancelled.
    assert.equal(automatic.optionId, null);
    assert.equal(automatic.refusal, 'not_per_call');

    const edit = chooseRuntimeOption('claude-code', offered('claude-code', 'edit-in-manual-mode'), 'once', true);
    assert.equal(edit.optionId, 'allow-once');
    assert.equal(edit.refusal, null);
  });

  it('refuses to answer automatically when the only allow is an unmeasured "always"', () => {
    const choice = chooseRuntimeOption(
      'some-new-runtime',
      [{ optionId: 'a', kind: 'allow_always' }],
      'once',
      true,
    );
    assert.equal(choice.optionId, null);
    assert.equal(choice.refusal, 'unexplained_allow');
  });

  it('says so when "always" could only get a single-call allow', () => {
    const choice = chooseRuntimeOption('omp', offered('omp', 'shell'), 'always');
    assert.equal(choice.optionId, 'allow_once');
    assert.equal(choice.downgraded, true);
  });

  it('denies this call only, never with a standing refusal', () => {
    // omp offers "Always reject". Taking it would refuse requests the owner
    // was never shown — the mirror of the standing grant, and just as wrong.
    const choice = chooseRuntimeOption('omp', offered('omp', 'shell'), 'deny');
    assert.equal(choice.optionId, 'reject_once');
  });

  it('cancels rather than inventing an option the runtime did not send', () => {
    for (const crafted of [
      undefined,
      null,
      'allow_once',
      42,
      {},
      [null, 7, 'allow-once'],
      [{ kind: 'allow_once' }],
      [{ optionId: 123, kind: 'allow_once' }],
      [{ optionId: 'allow-once', kind: 99 }],
      [{ optionId: '__proto__', kind: 'allow_always' }],
      [{ optionId: 'allow-once' }],
    ]) {
      for (const decision of ['once', 'always', 'deny'] as const) {
        const choice = chooseRuntimeOption('claude-code', crafted, decision);
        assert.equal(choice.optionId, null, `${JSON.stringify(crafted)} / ${decision}`);
      }
    }
  });

  it('only ever returns an option id the runtime itself sent', () => {
    for (const [runtime, probes] of Object.entries(FIXTURES)) {
      if (runtime.startsWith('_')) continue;
      for (const [name, probe] of Object.entries(probes)) {
        if (name.startsWith('_') || !Array.isArray(probe.options)) continue;
        const ids = probe.options.map((option) => option.optionId);
        for (const decision of ['once', 'always', 'deny'] as const) {
          for (const automatic of [false, true]) {
            const choice = chooseRuntimeOption(runtime, probe.options, decision, automatic);
            if (choice.optionId !== null) assert.ok(ids.includes(choice.optionId));
          }
        }
      }
    }
  });
});

describe('which runtime the semantics are looked up under', () => {
  it('reads an office-defined agent\'s real runtime, not its harness id', () => {
    // `host.ts` builds every office-defined agent with `harness: 'custom'` —
    // the command comes from the catalogue, so the spawn needs no harness id —
    // and the real runtime in `runtimeId`. Keyed on 'custom' the catalogue is
    // silently bypassed, which is the primary path for almost every agent.
    assert.equal(runtimeIdOf({ harness: 'custom', runtimeId: 'claude-code' }), 'claude-code');
    // A hand-run `--agent claude-code` carries it the other way round.
    assert.equal(runtimeIdOf({ harness: 'claude-code' }), 'claude-code');
  });

  it('keeps the plan-exit safeguard for a host-shaped config', () => {
    const plan = offered('claude-code', 'exit-plan-mode');
    const host = { harness: 'custom' as const, runtimeId: 'claude-code' };

    // The bug: under 'custom', `exit-plan-default` resolves through the ACP
    // kind default to this_call/this_call, so the run scope takes a session
    // policy change automatically and the card labels it "Allow once".
    const bypassed = chooseRuntimeOption('custom', plan, 'once', true);
    assert.equal(bypassed.optionId, 'exit-plan-default');
    assert.deepEqual(supportedOptions('custom', plan), [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ]);

    // Resolved properly: the run scope refuses, because approving a policy
    // change on the owner's behalf is not what the scope is for…
    const fixed = chooseRuntimeOption(runtimeIdOf(host), plan, 'once', true);
    assert.equal(fixed.optionId, null);
    assert.equal(fixed.refusal, 'not_per_call');
    // …while a person still gets the safe exit, named for what it leaves
    // behind rather than passed off as a single allow.
    assert.deepEqual(supportedOptions(runtimeIdOf(host), plan), [
      { id: 'allow_once', label: 'Allow, and keep asking' },
      { id: 'deny', label: 'Deny' },
    ]);
  });
});

describe('an option that buys less asking later', () => {
  it('is never chosen by payload order', () => {
    // Every plan-exit allow is session_policy + session, so breadth and
    // lifetime tie and the old sort fell back to whatever order the runtime
    // sent. Each permutation must land on the same safe option.
    const plan = offered('claude-code', 'exit-plan-mode');
    const rotations = plan.map((_, index) => [...plan.slice(index), ...plan.slice(0, index)]);
    for (const order of rotations) {
      assert.equal(
        chooseRuntimeOption('claude-code', order, 'once').optionId,
        'exit-plan-default',
        `order starting ${order[0]!.optionId}`,
      );
    }
    // Including the worst case explicitly: bypass listed first.
    const bypassFirst = [...plan].sort((a, b) =>
      a.optionId === 'exit-plan-bypass' ? -1 : b.optionId === 'exit-plan-bypass' ? 1 : 0,
    );
    assert.equal(bypassFirst[0]!.optionId, 'exit-plan-bypass');
    assert.equal(chooseRuntimeOption('claude-code', bypassFirst, 'once').optionId, 'exit-plan-default');
  });

  it('is not offered at all when it is the only allow', () => {
    // "Yes, and bypass permissions" alone. There is no honest allow button
    // here, so there is none — Deny is the whole choice.
    const options = [
      { optionId: 'exit-plan-bypass', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    assert.deepEqual(supportedOptions('claude-code', options), [{ id: 'deny', label: 'Deny' }]);
    assert.equal(chooseRuntimeOption('claude-code', options, 'always').optionId, null);
  });

  it('never labels the offerable session-policy exit as a plain "once"', () => {
    const options = [
      { optionId: 'exit-plan-default', kind: 'allow_once' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    assert.deepEqual(supportedOptions('claude-code', options), [
      { id: 'allow_once', label: 'Allow, and keep asking' },
      { id: 'deny', label: 'Deny' },
    ]);
  });

  it('drops a directory-wide grant from the card rather than ranking it last', () => {
    // Claude Code's `allow-with-updates` suppresses later asks in that
    // directory for the session. Explainable, but not something one click on
    // one request should buy, so the card offers the per-call allow only.
    assert.deepEqual(supportedOptions('claude-code', offered('claude-code', 'edit-in-manual-mode')), [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ]);
    const editOnly = [
      { optionId: 'allow-with-updates', kind: 'allow_always' },
      { optionId: 'reject', kind: 'reject_once' },
    ];
    assert.deepEqual(supportedOptions('claude-code', editOnly), [{ id: 'deny', label: 'Deny' }]);
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
