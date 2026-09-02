import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_COMMANDS,
  applyCommand,
  commandQueryAt,
  isAgentCommand,
  parseAgentCommand,
} from './commands.js';

describe('owner commands', () => {
  it('parses a bare command as aimed at everyone who hears it', () => {
    assert.deepEqual(parseAgentCommand('!cancel'), {
      name: 'cancel',
      target: null,
      body: '',
      known: true,
    });
  });

  it('picks up an @target so one agent can be stopped without stopping the fleet', () => {
    assert.deepEqual(parseAgentCommand('!shutdown @claude'), {
      name: 'shutdown',
      body: '',
      target: 'claude',
      known: true,
    });
  });

  it('reports an unknown verb rather than pretending it parsed', () => {
    const parsed = parseAgentCommand('!halp');
    assert.equal(parsed?.name, 'halp');
    assert.equal(parsed?.known, false);
  });

  it('is not a command unless it leads', () => {
    assert.equal(parseAgentCommand('as I said !cancel is the one'), null);
    assert.equal(parseAgentCommand('hey @claude'), null);
  });

  it('ignores a lone bang', () => {
    assert.equal(parseAgentCommand('!'), null);
    assert.equal(parseAgentCommand('!!!'), null);
  });

  it('is case-insensitive, because shouting still counts', () => {
    assert.equal(parseAgentCommand('!CANCEL')?.name, 'cancel');
    assert.ok(isAgentCommand('Rotate'));
  });
});

describe('command autocomplete', () => {
  it('opens on the leading bang and filters as you type', () => {
    assert.deepEqual(commandQueryAt('!', 1), { query: '', start: 0 });
    assert.deepEqual(commandQueryAt('!ro', 3), { query: 'ro', start: 0 });
  });

  it('stays shut when the caret is before the bang', () => {
    assert.equal(commandQueryAt('!cancel', 0), null);
  });

  it('closes once the verb is finished', () => {
    assert.equal(commandQueryAt('!cancel now', 11), null);
  });

  it('never opens mid-sentence', () => {
    assert.equal(commandQueryAt('tell me about !cancel', 21), null);
  });

  it('completes to a full command with a trailing space', () => {
    assert.deepEqual(applyCommand('!ro', 3, 'rotate'), { text: '!rotate ', caret: 8 });
  });

  it('keeps whatever followed the caret', () => {
    assert.deepEqual(applyCommand('!ro @claude', 3, 'rotate'), {
      text: '!rotate  @claude',
      caret: 8,
    });
  });

  it('advertises only verbs the harness implements', () => {
    for (const command of AGENT_COMMANDS) {
      assert.ok(isAgentCommand(command.name), `${command.name} must be known`);
      assert.ok(command.summary.length > 0 && command.detail.length > 0);
    }
  });
});

/**
 * `!remember` is the first command that carries text, so the body has to
 * survive exactly as written. What somebody wants an agent to remember is
 * prose, and trimming it to a token would change what they said.
 */
describe('a command that carries text', () => {
  it('keeps everything after the verb', () => {
    assert.deepEqual(parseAgentCommand('!remember always greet people in Portuguese'), {
      name: 'remember',
      target: null,
      body: 'always greet people in Portuguese',
      known: true,
    });
  });

  it('strips a leading @target but not a name inside the note', () => {
    assert.deepEqual(parseAgentCommand('!remember @marvin be terse'), {
      name: 'remember',
      target: 'marvin',
      body: 'be terse',
      known: true,
    });

    // Naming somebody mid-sentence is part of the note, not an address.
    const parsed = parseAgentCommand('!remember ask @sam before deploying');
    assert.equal(parsed?.body, 'ask @sam before deploying');
  });

  it('leaves the body empty when there is nothing after the verb', () => {
    assert.equal(parseAgentCommand('!remember')?.body, '');
    assert.equal(parseAgentCommand('!remember   ')?.body, '');
  });

  it('keeps the commands that take nothing unchanged', () => {
    assert.equal(parseAgentCommand('!cancel')?.body, '');
    assert.equal(parseAgentCommand('!shutdown @claude')?.body, '');
  });
});

describe('who a command is aimed at', () => {
  /**
   * The target used to be the first `@mention` anywhere in the message, which
   * was fine while every command was a bare verb. A command that carries prose
   * changes that: prose names people.
   */
  it('does not treat a name inside a note as an address', () => {
    const parsed = parseAgentCommand('!remember ask @sam before deploying');
    assert.equal(
      parsed?.target,
      null,
      'otherwise every agent not called Sam silently drops the note',
    );
    assert.equal(parsed?.body, 'ask @sam before deploying');
  });

  it('still targets when the mention leads', () => {
    assert.equal(parseAgentCommand('!shutdown @claude')?.target, 'claude');
    assert.equal(parseAgentCommand('!remember @marvin be terse')?.target, 'marvin');
  });
});
