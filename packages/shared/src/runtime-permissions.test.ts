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
  VERIFICATION_WINDOW_DAYS,
  adapterMoved,
  profileStaleness,
  verificationExpired,
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

describe('when the runtime stops being the one that was measured', () => {
  const claude = permissionProfile('claude-code')!;
  const measured = claude.verifiedAgainst!;

  it('says nothing when the adapter is the one the evidence names', () => {
    assert.equal(adapterMoved(claude, measured), null);
    assert.equal(profileStaleness(claude, measured, new Date(claude.verifiedAt)), null);
  });

  it('says nothing when nobody looked, rather than assuming the worst', () => {
    // Most callers never see a handshake. "Did not look" must not read as
    // "moved", or every path in the office would degrade for no reason.
    assert.equal(adapterMoved(claude, undefined), null);
    assert.equal(adapterMoved(claude, null), null);
  });

  it('notices a bumped version, and names both sides', () => {
    const moved = adapterMoved(claude, { ...measured, version: '0.82.0' });
    assert.equal(moved?.reason, 'version_moved');
    assert.match(moved!.catalogued, /0\.81\.2$/);
    assert.match(moved!.observed!, /0\.82\.0$/);
  });

  it('notices a renamed adapter at the same version', () => {
    // A rename is not a smaller change than a bump: it is a different
    // package, and the evidence describes the old one.
    assert.equal(adapterMoved(claude, { name: 'claude-acp-fork', version: measured.version })?.reason, 'version_moved');
  });

  it('cannot go stale where nothing was measured', () => {
    // Goose is `unknown` for want of an install. There is no version for it
    // to have moved from, and collapsing that into `expired` would lose the
    // distinction the type exists to keep.
    const goose = permissionProfile('goose')!;
    assert.equal(goose.verifiedAgainst, null);
    assert.equal(profileStaleness(goose, { name: 'goose', version: '9.9.9' }), null);
  });
});

describe('the degraded state a moved adapter leaves behind', () => {
  const moved = { name: '@agentclientprotocol/claude-agent-acp', version: '0.99.0' } as const;

  it('stops trusting the catalogue\'s option ids', () => {
    // `allow-with-updates` is catalogued as directory-wide for this session.
    // Against an adapter nobody measured, that is no longer evidence.
    const trusted = optionSemantics('claude-code', { optionId: 'allow-with-updates', kind: 'allow_always' });
    assert.equal(trusted.breadth, 'directory');

    const stale = optionSemantics('claude-code', { optionId: 'allow-with-updates', kind: 'allow_always' }, moved);
    assert.equal(stale.breadth, 'unknown');
    assert.equal(grantIsExplainable(stale), false);
    assert.equal(grantIsOfferable(stale), false);
  });

  it('keeps the plan-exit ids from being read as their ACP kind', () => {
    // The worst outcome of degrading would be falling *back* into the bug
    // QUIN-53 fixed: `exit-plan-bypass` is kind `allow_always`, which has no
    // spec default, so it stays unexplained rather than becoming an allow.
    const bypass = optionSemantics('claude-code', { optionId: 'exit-plan-bypass', kind: 'allow_always' }, moved);
    assert.equal(grantIsOfferable(bypass), false);
  });

  it('is degraded, not dead: allow_once still resolves through the spec', () => {
    // This is the whole reason the policy is "fall back" and not "refuse".
    // An owner with a bumped adapter keeps a usable per-call Allow.
    const once = optionSemantics('claude-code', { optionId: 'allow-once', kind: 'allow_once' }, moved);
    assert.equal(grantIsPerCall(once), true);
    assert.equal(grantIsOfferable(once), true);
    assert.equal(grantLabel(once), 'Allow once');
  });

  it('still refuses an id measured as broader than per-call', () => {
    // The asymmetry the degrade rests on: stale evidence cannot license an
    // allow, but it can still license a refusal. Without this,
    // `exit-plan-default` (kind `allow_once`, really a session-policy
    // switch) degrades into a per-call allow and the run scope takes a
    // policy change automatically — the exact bug QUIN-53 closed, back the
    // moment an adapter bumps its version.
    const exit = optionSemantics('claude-code', { optionId: 'exit-plan-default', kind: 'allow_once' }, moved);
    assert.equal(grantIsPerCall(exit), false);
    assert.equal(grantIsOfferable(exit), false);

    // A version bump is no reason to believe a grant got *narrower*, so the
    // same holds for every catalogued option that is not per-call.
    for (const entry of permissionProfile('claude-code')!.options) {
      if (!entry.optionId || grantIsPerCall(entry)) continue;
      const stale = optionSemantics('claude-code', { optionId: entry.optionId, kind: entry.kind }, moved);
      assert.equal(grantIsOfferable(stale), false, `${entry.optionId} must stay unofferable when stale`);
    }
  });

  it('lands in exactly the state an uncatalogued runtime is already in', () => {
    // The acceptance condition for choosing this policy over a new one: no
    // second degraded mode to reason about, just the existing safe path.
    for (const kind of ['allow_once', 'allow_always', 'reject_once'] as const) {
      assert.deepEqual(
        optionSemantics('claude-code', { optionId: 'whatever', kind }, moved),
        optionSemantics('a-runtime-nobody-probed', { optionId: 'whatever', kind }),
        `${kind} degrades to the uncatalogued answer`,
      );
    }
  });
});

describe('a measurement that has simply aged out', () => {
  it('holds inside the window and fails past it', () => {
    const claude = permissionProfile('claude-code')!;
    const day = 86_400_000;
    const verified = Date.parse(`${claude.verifiedAt}T00:00:00Z`);
    assert.equal(verificationExpired(claude, new Date(verified + day)), null);
    const expired = verificationExpired(claude, new Date(verified + (VERIFICATION_WINDOW_DAYS + 1) * day));
    assert.equal(expired?.reason, 'expired');
  });

  it('does not degrade a live decision, because no adapter moved', () => {
    // Expiry is a debt this repository owes, not a fact about the runtime on
    // somebody's laptop. It fails the catalogue check below; it must not
    // quietly narrow an owner's buttons because a date passed.
    const semantics = optionSemantics('claude-code', {
      optionId: 'allow-with-updates',
      kind: 'allow_always',
    });
    assert.equal(semantics.breadth, 'directory');
  });

  it('every catalogued entry is still inside its verification window', () => {
    // The forcing function. When this fails, nothing is broken — the
    // measurements are just old. Re-run the probes and re-record: see
    // docs/RUNTIME-PERMISSIONS.md, "Re-establishing it".
    for (const profile of RUNTIME_PERMISSIONS) {
      const expired = verificationExpired(profile);
      assert.equal(
        expired,
        null,
        `${profile.runtimeId} was last established on ${profile.verifiedAt}, more than ${VERIFICATION_WINDOW_DAYS} days ago — re-probe it`,
      );
    }
  });

  it('names the adapter it was measured against, wherever anything was', () => {
    for (const profile of RUNTIME_PERMISSIONS) {
      if (profile.options.length === 0) continue;
      assert.ok(
        profile.verifiedAgainst,
        `${profile.runtimeId} catalogues options but names no adapter to check them against`,
      );
    }
  });
});

describe('the limit this cannot reach', () => {
  it('cannot see a renamed option whose ACP kind lies about it', () => {
    // Recorded as failing-by-design, to the same standard as the reused-id
    // gap below — the escape to the spec default is only safe when the
    // renamed id's kind is honest.
    //
    // Keeping the id is caught by the asymmetry…
    const moved = { name: '@agentclientprotocol/claude-agent-acp', version: '0.99.0' };
    assert.equal(
      grantIsOfferable(optionSemantics('claude-code', { optionId: 'exit-plan-default', kind: 'allow_once' }, moved)),
      false,
    );

    // …but renaming it is not. `exit-plan-manual` is unknown to the
    // catalogue, so it lands on SPEC_DEFAULTS.allow_once and becomes an
    // offerable per-call allow the run scope takes automatically. That is
    // QUIN-53's bug through a rename, and it is asserted here rather than
    // hidden: a renamed lying id is indistinguishable at the payload from a
    // new honest per-call option, and refusing every unrecognised
    // `allow_once` would kill "degraded, not dead" for plain renames.
    const renamed = optionSemantics('claude-code', { optionId: 'exit-plan-manual', kind: 'allow_once' }, moved);
    assert.equal(grantIsPerCall(renamed), true, 'reads as per-call, which it is not');
    assert.equal(grantIsOfferable(renamed), true, 'and is therefore offered — the gap, stated');
  });

  it('cannot see an option id that kept its name and widened its meaning', () => {
    // Recorded as a failing-by-design case rather than left implicit.
    //
    // If a future adapter keeps `allow-with-updates` but starts persisting
    // the grant, the catalogue keeps describing it as session-scoped and the
    // button keeps promising that. Nothing in this tree notices, because the
    // difference is not in the payload — only in behaviour. The version
    // check above is what makes it *survivable*: the meaning can only drift
    // under a version that also moved, and a moved version stops the
    // catalogue being trusted at all.
    const sameVersion = permissionProfile('claude-code')!.verifiedAgainst!;
    const semantics = optionSemantics(
      'claude-code',
      { optionId: 'allow-with-updates', kind: 'allow_always' },
      sameVersion,
    );
    assert.equal(semantics.lifetime, 'session', 'still described as the evidence recorded it');
    assert.equal(
      adapterMoved(permissionProfile('claude-code')!, sameVersion),
      null,
      'and nothing flags it, which is the gap: only re-probing closes this one',
    );
  });
});
