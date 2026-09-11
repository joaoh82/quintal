import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mentionedNames } from './settings.js';
import {
  isMentionableTeamName,
  mayManageTeams,
  normaliseTeamName,
  teamPickerSubtitle,
} from './team.js';

/**
 * A team's name is what people type after `@`, so the one rule that matters
 * is that a name the page accepts is a name the mention parser reads back.
 */
describe('a team name', () => {
  it('is one mention token, and reads back as itself', () => {
    for (const name of ['engineering', 'Eng-2', 'front_end', 'équipe']) {
      assert.equal(isMentionableTeamName(name), true, name);
      assert.deepEqual(mentionedNames(`hey @${name} look`), [name.toLowerCase()]);
    }
    for (const name of ['front end', '', '-eng', 'eng.ops', 'a@b']) {
      assert.equal(isMentionableTeamName(name), false, JSON.stringify(name));
    }
  });

  it('is trimmed and capped, never reshaped', () => {
    assert.equal(normaliseTeamName('  engineering  '), 'engineering');
    assert.equal(normaliseTeamName('x'.repeat(60)).length, 40);
    assert.equal(normaliseTeamName(undefined), '');
  });
});

describe('who may manage teams', () => {
  it('is office admins only', () => {
    assert.equal(mayManageTeams({ userId: 'u', role: 'owner' }), true);
    assert.equal(mayManageTeams({ userId: 'u', role: 'admin' }), true);
    assert.equal(mayManageTeams({ userId: 'u', role: 'member' }), false);
    assert.equal(mayManageTeams({ userId: 'u', role: null }), false);
  });
});

describe('the picker subtitle', () => {
  it('counts agents, singular and plural', () => {
    assert.equal(teamPickerSubtitle({ members: [] }), 'team · 0 agents');
    assert.equal(teamPickerSubtitle({ members: [{ id: 'a', name: 'A' }] }), 'team · 1 agent');
    assert.equal(
      teamPickerSubtitle({ members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
      'team · 2 agents',
    );
  });
});
