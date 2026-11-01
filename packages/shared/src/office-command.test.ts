import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AGENT_INSTRUCTIONS_MAX_LENGTH } from './agent.js';
import { parseAgentCommand } from './commands.js';
import {
  findOfficeCommand,
  isOfficeCommandName,
  isReservedCommandName,
  mayCreateOfficeCommands,
  mayEditOfficeCommand,
  normaliseOfficeCommandInstructions,
  normaliseOfficeCommandName,
  OFFICE_COMMAND_INSTRUCTIONS_MAX_LENGTH,
  officeCommandAuthorLabel,
  officeCommandUsage,
  type OfficeCommandRef,
} from './office-command.js';

const review: OfficeCommandRef = {
  id: 'c1',
  name: 'review',
  summary: 'Review a pull request',
  argumentHint: '<pull request link>',
  defaultTarget: null,
};

describe('office command names', () => {
  it('is what parseAgentCommand would read back: lowercase, without the bang', () => {
    assert.equal(normaliseOfficeCommandName(' !Review '), 'review');
    assert.ok(isOfficeCommandName('review'));
    assert.ok(isOfficeCommandName('tweet-draft'));
  });

  it('refuses what cannot be typed as one word after !', () => {
    assert.equal(isOfficeCommandName(''), false);
    assert.equal(isOfficeCommandName('code review'), false);
    assert.equal(isOfficeCommandName('-review'), false);
  });

  it('keeps the built-in verbs for themselves', () => {
    assert.ok(isReservedCommandName('cancel'));
    assert.ok(isReservedCommandName('Task'));
    assert.equal(isReservedCommandName('review'), false);
  });
});

describe('who a command is by', () => {
  it('is the person, or the person via the agent that wrote it for them', () => {
    assert.equal(officeCommandAuthorLabel({ createdByName: 'Josh' }), 'Josh');
    assert.equal(officeCommandAuthorLabel({ createdByName: 'Josh', createdByAgentName: 'Marvin' }), 'Josh, via Marvin');
    assert.equal(officeCommandAuthorLabel({ createdByName: '', createdByAgentName: 'Marvin' }), 'Marvin, an agent');
    assert.equal(officeCommandAuthorLabel({ createdByName: '', createdByAgentName: null }), '');
  });
});

describe('finding the command a line names', () => {
  it('finds it with its target and argument parsed the usual way', () => {
    const parsed = parseAgentCommand('!review @engineering https://github.com/o/r/pull/1');
    assert.equal(findOfficeCommand(parsed, [review]), review);
    assert.equal(parsed?.target, 'engineering');
    assert.equal(parsed?.body, 'https://github.com/o/r/pull/1');
  });

  it('is case-insensitive, the way built-ins are', () => {
    assert.equal(findOfficeCommand(parseAgentCommand('!REVIEW x'), [review]), review);
  });

  it('never shadows a built-in, even if a row somehow had its name', () => {
    const shadow = { ...review, name: 'cancel' };
    assert.equal(findOfficeCommand(parseAgentCommand('!cancel'), [shadow]), null);
  });

  it('is nothing for an unknown verb or a line that is not a command', () => {
    assert.equal(findOfficeCommand(parseAgentCommand('!halp'), [review]), null);
    assert.equal(findOfficeCommand(parseAgentCommand('please !review'), [review]), null);
  });
});

describe('who may make and change commands', () => {
  it('lets any member make one, and no guest', () => {
    assert.ok(mayCreateOfficeCommands({ userId: 'u', role: 'member' }));
    assert.equal(mayCreateOfficeCommands({ userId: 'u', role: null }), false);
  });

  it('lets the author or an admin change one, and nobody else', () => {
    const command = { createdBy: 'ana' };
    assert.ok(mayEditOfficeCommand({ userId: 'ana', role: 'member' }, command));
    assert.ok(mayEditOfficeCommand({ userId: 'bo', role: 'admin' }, command));
    assert.ok(mayEditOfficeCommand({ userId: 'bo', role: 'owner' }, command));
    assert.equal(mayEditOfficeCommand({ userId: 'bo', role: 'member' }, command), false);
    assert.equal(mayEditOfficeCommand({ userId: 'ana', role: null }, command), false);
  });

  it('leaves an orphaned command to the admins', () => {
    assert.equal(mayEditOfficeCommand({ userId: 'bo', role: 'member' }, { createdBy: null }), false);
  });
});

describe('how a command is written out', () => {
  it('asks for a name when it has no default', () => {
    assert.equal(officeCommandUsage(review), '!review @name <pull request link>');
  });

  it('shows the default as optional when it has one', () => {
    assert.equal(
      officeCommandUsage({
        ...review,
        defaultTarget: { kind: 'team', id: 't', name: 'reviewers' },
      }),
      '!review [@reviewers] <pull request link>',
    );
  });
});

describe('office command instructions', () => {
  it('keeps a brief far longer than an agent’s own instructions, lines intact', () => {
    const brief = Array.from({ length: 200 }, (_, i) => `${i + 1}. Check the thing that breaks.`).join('\n');
    assert.ok(brief.length > AGENT_INSTRUCTIONS_MAX_LENGTH);
    assert.equal(normaliseOfficeCommandInstructions(brief), brief);
  });

  it('is still capped, by code point', () => {
    const long = '🙂'.repeat(OFFICE_COMMAND_INSTRUCTIONS_MAX_LENGTH + 5);
    assert.equal(Array.from(normaliseOfficeCommandInstructions(long)).length, OFFICE_COMMAND_INSTRUCTIONS_MAX_LENGTH);
  });
});
