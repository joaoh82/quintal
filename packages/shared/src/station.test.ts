import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDeskBegin } from './station.js';

describe('what a desk is told to begin', () => {
  it('reads a note by id, and ignores a title sent beside it', () => {
    assert.deepEqual(parseDeskBegin({ seatId: 'bay-1', agentId: 'a1', itemId: 'n1', title: 'ignored' }), {
      seatId: 'bay-1',
      agentId: 'a1',
      what: { kind: 'note', itemId: 'n1' },
    });
  });

  it('reads a typed task as the board reads a note', () => {
    assert.deepEqual(parseDeskBegin({ seatId: 'bay-1', agentId: 'a1', title: '  Fix the chair  ', body: ' why \n' }), {
      seatId: 'bay-1',
      agentId: 'a1',
      what: { kind: 'typed', title: 'Fix the chair', body: 'why' },
    });
  });

  it('refuses one that names no desk, no agent, or nothing to do', () => {
    assert.equal(parseDeskBegin({ agentId: 'a1', title: 'x' }), null);
    assert.equal(parseDeskBegin({ seatId: 'bay-1', title: 'x' }), null);
    assert.equal(parseDeskBegin({ seatId: 'bay-1', agentId: 'a1' }), null);
    assert.equal(parseDeskBegin({ seatId: 'bay-1', agentId: 'a1', title: '   ' }), null);
    assert.equal(parseDeskBegin({ seatId: 'bay-1', agentId: 'a1', itemId: '' }), null, 'an empty id is not "no note"');
    assert.equal(parseDeskBegin(null), null);
    assert.equal(parseDeskBegin('bay-1'), null);
  });
});
