import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressedNames } from '@quintal/shared';
import type { OfficeCommandSummary } from '@quintal/shared/db';

import { commandCallFor, readCommandLine, unheardNotice } from './commands.js';
import { resolveMentions } from './mentions.js';

/**
 * `!review @engineering <link>` has to reach exactly who `@engineering
 * <link>` would have, with the brief on it — and `!review <link>` has to go
 * to the command's default when it has one, and to whoever is near when it
 * does not. Getting it wrong is a review nobody was asked for, or one that
 * three agents and a passer-by all start.
 */

const josh = { id: 'u-josh', name: 'Josh', kind: 'human' as const };
const claude = { id: 'a-claude', name: 'Claude', kind: 'agent' as const };
const codex = { id: 'a-codex', name: 'Codex', kind: 'agent' as const };
const engineering = {
  id: 't-eng',
  name: 'engineering',
  members: [claude, codex].map(({ id, name }) => ({ id, name })),
};
const audience = [josh, claude, codex];
const teams = [engineering];

function command(overrides: Partial<OfficeCommandSummary> = {}): OfficeCommandSummary {
  return {
    id: 'c-review',
    workspaceId: 'w',
    name: 'review',
    summary: 'Review a pull request',
    argumentHint: '<pull request link>',
    instructions: 'Read the diff; say what would break.',
    defaultTarget: null,
    createdBy: josh.id,
    createdByName: 'Josh',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** What the room does: read the names, read the command, resolve what it says. */
function deliver(text: string, commands: OfficeCommandSummary[], speakerKind: 'human' | 'agent' = 'human') {
  const named = addressedNames(text, [...audience.map((m) => m.name), ...teams.map((t) => t.name)]);
  const line = readCommandLine(text, speakerKind, commands, named);
  const resolved = resolveMentions(line?.named ?? named, audience, teams, josh.id);
  return { line, resolved };
}

describe('reading an office command', () => {
  it('reaches a team the way a mention would, with the brief and the argument on it', () => {
    const { line, resolved } = deliver('!review @engineering https://github.com/o/r/pull/1', [command()]);
    assert.ok(line);
    assert.equal(line.aimed, true);
    assert.deepEqual([...resolved.reached.keys()].sort(), [claude.id, codex.id]);

    const call = commandCallFor(line, resolved.reached.get(claude.id));
    assert.deepEqual(call, {
      name: 'review',
      instructions: 'Read the diff; say what would break.',
      args: 'https://github.com/o/r/pull/1',
      definedBy: 'Josh',
      addressed: true,
    });
  });

  it('goes to the default target when the line names nobody', () => {
    const withDefault = command({ defaultTarget: { kind: 'team', id: engineering.id, name: 'engineering' } });
    const { line, resolved } = deliver('!review https://github.com/o/r/pull/1', [withDefault]);
    assert.deepEqual(line?.named, ['engineering']);
    assert.equal(resolved.reached.get(codex.id)?.viaTeam?.name, 'engineering');
    assert.equal(line?.args, 'https://github.com/o/r/pull/1');
  });

  it('does not override a name the line did say', () => {
    const withDefault = command({ defaultTarget: { kind: 'team', id: engineering.id, name: 'engineering' } });
    const { line, resolved } = deliver('!review @claude https://x', [withDefault]);
    assert.deepEqual([...resolved.reached.keys()], [claude.id]);
    assert.equal(commandCallFor(line!, resolved.reached.get(codex.id)), undefined, 'Codex only overheard it');
  });

  it('keeps a name nobody here has, rather than guessing the default was meant', () => {
    const withDefault = command({ defaultTarget: { kind: 'agent', id: claude.id, name: 'Claude' } });
    const { line, resolved } = deliver('!review @calude https://x', [withDefault]);
    assert.equal(line?.aimed, true);
    assert.equal(resolved.reached.size, 0);
    assert.match(unheardNotice(line!), /@calude/);
  });

  it('with nobody named and no default, is for whoever a plain line would be for', () => {
    const { line, resolved } = deliver('!review https://x', [command()]);
    assert.equal(line?.aimed, false);
    assert.equal(resolved.reached.size, 0);
    assert.deepEqual(commandCallFor(line!, undefined)?.addressed, false);
    assert.match(unheardNotice(line!), /!review @name <pull request link>/);
  });

  it('is nothing when an agent types it, or when it is not one of the office’s', () => {
    assert.equal(deliver('!review @claude x', [command()], 'agent').line, null);
    assert.equal(deliver('!tweet @claude x', [command()]).line, null);
    assert.equal(deliver('!cancel @claude', [command({ name: 'cancel' })]).line, null);
    assert.equal(deliver('please !review this', [command()]).line, null);
  });
});
