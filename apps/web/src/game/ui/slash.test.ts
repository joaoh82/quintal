import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSlashCommand, slashQueryAt } from './slash.js';

describe('slash commands', () => {
  it('leaves ordinary chat alone, including a literal slash', () => {
    assert.equal(parseSlashCommand('hello'), null);
    assert.equal(parseSlashCommand('  /'), null, 'a bare slash is nothing');
    assert.equal(parseSlashCommand('//not a command'), null);
  });

  it('opens a DM by name, with or without the @', () => {
    assert.deepEqual(parseSlashCommand('/msg Marvin'), { kind: 'msg', name: 'Marvin' });
    assert.deepEqual(parseSlashCommand('/dm @Marvin'), { kind: 'msg', name: 'Marvin' });
  });

  it('joins by slug, however it was written', () => {
    assert.deepEqual(parseSlashCommand('/join #Engineering'), { kind: 'join', slug: 'engineering' });
  });

  it('names an unknown verb rather than sending it as chat', () => {
    assert.deepEqual(parseSlashCommand('/dance'), { kind: 'unknown', name: 'dance' });
  });
});

describe('what to complete', () => {
  it('offers verbs until the first space, then the argument', () => {
    assert.deepEqual(slashQueryAt('/jo', 3), { part: 'verb', verb: '', query: 'jo', start: 1 });
    assert.deepEqual(slashQueryAt('/join eng', 9), {
      part: 'argument',
      verb: 'join',
      query: 'eng',
      start: 6,
    });
  });

  it('stops once the line has moved past the argument', () => {
    assert.equal(slashQueryAt('/msg Marvin hello', 17), null);
    assert.equal(slashQueryAt('plain text', 5), null);
  });
});
