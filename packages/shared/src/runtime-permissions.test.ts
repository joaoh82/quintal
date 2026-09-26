import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RUNTIMES } from './runtimes.js';
import {
  GRANT_BREADTHS,
  GRANT_LIFETIMES,
  RUNTIME_PERMISSIONS,
  compareGrants,
  describeGrant,
  grantIsExplainable,
  grantIsOfferable,
  grantIsPerCall,
  grantLabel,
  optionSemantics,
  permissionProfile,
} from './runtime-permissions.js';

describe('what a runtime option is established to grant', () => {
  it('reads the runtime\'s own option id before its ACP kind', () => {
    // Claude Code's plan-exit request carries three options of kind
    // `allow_always`, and the one that matters is told apart by id alone.
    const bypass = optionSemantics('claude-code', {
      optionId: 'exit-plan-bypass',
      kind: 'allow_always',
    });
    assert.equal(bypass.breadth, 'session_policy');
    assert.equal(bypass.lifetime, 'session');

    const edit = optionSemantics('claude-code', {
      optionId: 'allow-with-updates',
      kind: 'allow_always',
    });
    assert.equal(edit.breadth, 'directory');
    assert.equal(edit.lifetime, 'session');
  });

  it('does not let one option\'s meaning stand in for its neighbours', () => {
    // `exit-plan-default` is kind `allow_once` and is *not* a per-call allow.
    // Nothing about it may be read across to an uncatalogued `allow_once`.
    assert.equal(grantIsPerCall(optionSemantics('claude-code', { optionId: 'exit-plan-default', kind: 'allow_once' })), false);
    assert.equal(grantIsPerCall(optionSemantics('claude-code', { optionId: 'allow-once', kind: 'allow_once' })), true);
  });

  it('falls back to what ACP defines, and to nothing where it defines nothing', () => {
    const once = optionSemantics('a-runtime-nobody-probed', { optionId: 'x', kind: 'allow_once' });
    assert.equal(grantIsPerCall(once), true);

    const always = optionSemantics('a-runtime-nobody-probed', { optionId: 'x', kind: 'allow_always' });
    assert.equal(always.breadth, 'unknown');
    assert.equal(always.lifetime, 'unknown');
    assert.equal(grantIsExplainable(always), false);
  });

  it('answers unknown for anything malformed or uncatalogued', () => {
    // A catalogued id still resolves without a kind — the id is where the
    // meaning lives — but nothing else does.
    assert.equal(grantIsExplainable(optionSemantics('claude-code', { optionId: 'allow-once' })), true);
    for (const option of [
      {},
      { optionId: 42, kind: 7 },
      { optionId: null, kind: undefined },
      { kind: 'allow_maybe' },
      { optionId: 'an-id-nobody-catalogued' },
    ]) {
      assert.equal(grantIsExplainable(optionSemantics('claude-code', option as never)), false);
    }
  });

  it('never claims a runtime nobody could probe was verified', () => {
    for (const id of ['gemini', 'goose']) {
      const profile = permissionProfile(id)!;
      assert.equal(profile.asks, 'unknown');
      assert.deepEqual(profile.options, []);
    }
    // Codex was driven end to end and never asked. That is a finding, not an
    // unknown, and it must not read as "Quintal approves its tools".
    assert.equal(permissionProfile('codex')!.asks, 'never_observed');
    assert.ok(permissionProfile('codex')!.externalGrants);
  });
});

describe('ranking one grant against another', () => {
  it('puts the narrowest first', () => {
    const perCall = optionSemantics('omp', { optionId: 'allow_once', kind: 'allow_once' });
    const category = optionSemantics('omp', { optionId: 'allow_always', kind: 'allow_always' });
    assert.ok(compareGrants(perCall, category) < 0);
    assert.ok(compareGrants(category, perCall) > 0);
    assert.equal(compareGrants(perCall, perCall), 0);
  });

  it('separates the plan-exit options that breadth alone ties', () => {
    // All four are session_policy + session. Without the loosening term they
    // rank equal and the winner is whatever order the runtime sent — so
    // "manually approve edits" and "bypass permissions" were interchangeable.
    const exit = (optionId: string) => optionSemantics('claude-code', { optionId, kind: 'allow_always' });
    const manual = optionSemantics('claude-code', { optionId: 'exit-plan-default', kind: 'allow_once' });
    for (const id of ['exit-plan-auto', 'exit-plan-clear-auto', 'exit-plan-bypass']) {
      assert.equal(exit(id).breadth, manual.breadth, `${id} breadth ties, by design`);
      assert.equal(exit(id).lifetime, manual.lifetime, `${id} lifetime ties, by design`);
      assert.ok(compareGrants(manual, exit(id)) < 0, `${id} must rank after the manual exit`);
    }
  });
});

describe('which grants may be put on a card at all', () => {
  it('refuses an option that buys less asking later, however narrow', () => {
    // The card is answering *this* request. "And stop asking me" is not a
    // rider the owner agreed to by clicking one button.
    for (const [runtime, optionId] of [
      ['claude-code', 'allow-with-updates'],
      ['claude-code', 'exit-plan-bypass'],
      ['claude-code', 'exit-plan-auto'],
      ['claude-code', 'exit-plan-clear-auto'],
      ['omp', 'allow_always'],
    ] as const) {
      const semantics = optionSemantics(runtime, { optionId, kind: 'allow_always' });
      assert.equal(grantIsExplainable(semantics), true, `${optionId} is explainable`);
      assert.equal(grantIsOfferable(semantics), false, `${optionId} must not be offerable`);
    }
  });

  it('allows the per-call ones, and the plan exit that keeps asking', () => {
    assert.equal(grantIsOfferable(optionSemantics('omp', { optionId: 'allow_once', kind: 'allow_once' })), true);
    assert.equal(
      grantIsOfferable(optionSemantics('claude-code', { optionId: 'exit-plan-default', kind: 'allow_once' })),
      true,
    );
  });

  it('refuses anything unestablished, which is assumed to loosen', () => {
    const unknown = optionSemantics('nobody-probed-this', { optionId: 'x', kind: 'allow_always' });
    assert.equal(unknown.loosensFuturePermission, true);
    assert.equal(grantIsOfferable(unknown), false);
  });
});

describe('what a person is told', () => {
  it('never labels a broader grant as "once"', () => {
    for (const profile of RUNTIME_PERMISSIONS) {
      for (const option of profile.options) {
        if (grantIsPerCall(option)) continue;
        assert.notEqual(grantLabel(option), 'Allow once', `${profile.runtimeId}/${option.optionId}`);
      }
    }
  });

  it('gives every offerable option a label short enough to survive the wire', () => {
    // `parseApprovalRequest` truncates a label to 40 characters. One clipped
    // from "Allow here, this session" to "Allow here" would read narrower than
    // it is, which is the failure this whole module exists to prevent.
    for (const profile of RUNTIME_PERMISSIONS) {
      for (const option of profile.options) {
        if (!grantIsOfferable(option)) continue;
        assert.ok(
          grantLabel(option).length <= 40,
          `${profile.runtimeId}/${option.optionId}: ${grantLabel(option)}`,
        );
      }
    }
  });

  it('says both halves of what it grants', () => {
    assert.equal(
      describeGrant(optionSemantics('claude-code', { optionId: 'allow-with-updates', kind: 'allow_always' })),
      'anything like it in the working directory, until this session ends',
    );
    assert.equal(
      describeGrant(optionSemantics('omp', { optionId: 'allow_once', kind: 'allow_once' })),
      'this one action, once',
    );
  });
});

describe('the catalogue itself', () => {
  it('only names runtimes the office knows how to run', () => {
    for (const profile of RUNTIME_PERMISSIONS) {
      assert.ok(
        RUNTIMES.some((runtime) => runtime.id === profile.runtimeId),
        `${profile.runtimeId} is not a runtime`,
      );
    }
  });

  it('carries a date and a stated breadth and lifetime on every entry', () => {
    for (const profile of RUNTIME_PERMISSIONS) {
      assert.match(profile.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
      for (const option of profile.options) {
        assert.ok(GRANT_BREADTHS.includes(option.breadth));
        assert.ok(GRANT_LIFETIMES.includes(option.lifetime));
        // An entry with no evidence is a guess wearing a table's clothes.
        assert.ok(option.evidence.length > 10, `${profile.runtimeId}/${option.optionId}`);
        // Anything claimed to outlive the process has to say where it lives,
        // or nobody can be told how to revoke it.
        if (option.lifetime === 'persisted') assert.ok(option.persistsAt);
        // Stated per option rather than derived: the whole point is that
        // breadth and lifetime do not imply it.
        assert.equal(typeof option.loosensFuturePermission, 'boolean');
        // A per-call allow that loosens future permission is a contradiction.
        if (grantIsPerCall(option)) {
          assert.equal(option.loosensFuturePermission, false, `${profile.runtimeId}/${option.optionId}`);
        }
      }
    }
  });
});
