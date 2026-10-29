import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOARD_LABELS_MAX,
  BOARD_TITLE_MAX_LENGTH,
  mayAssignBoardItem,
  mayDeleteBoardItem,
  mayWriteBoard,
  normaliseBoardLabels,
  noteForTask,
  normaliseBoardTitle,
  parseBoardCreate,
  parseBoardUpdate,
} from './board.js';

/**
 * A note on the board is read by everybody in the office and written by
 * anybody in it, so what reaches the row is rebuilt here: a title that is
 * one line, labels that are chips, a status the board has a column for.
 */
describe('a note', () => {
  it('needs a title, on one line', () => {
    assert.equal(normaliseBoardTitle('  Fix the   login\nredirect '), 'Fix the login redirect');
    assert.equal(normaliseBoardTitle('   '), null);
    assert.equal(normaliseBoardTitle(42), null);
    assert.equal(normaliseBoardTitle('x'.repeat(500))?.length, BOARD_TITLE_MAX_LENGTH);
  });

  it('keeps labels short, distinct in any case, and few', () => {
    assert.deepEqual(normaliseBoardLabels(['bug', ' Bug ', 'ui', '']), ['bug', 'ui']);
    assert.deepEqual(normaliseBoardLabels('bug, priority: high,,ui'), ['bug', 'priority: high', 'ui']);
    assert.deepEqual(normaliseBoardLabels([1, null, 'ok']), ['ok']);
    assert.equal(
      normaliseBoardLabels(Array.from({ length: 30 }, (_, i) => `l${i}`)).length,
      BOARD_LABELS_MAX,
    );
  });
});

describe('what board_create accepts', () => {
  it('fills in the column and the colour when they are not said', () => {
    assert.deepEqual(parseBoardCreate({ title: 'Add a garden' }), {
      title: 'Add a garden',
      body: '',
      status: 'open',
      color: 'yellow',
      labels: [],
      assigneeAgentId: null,
    });
  });

  it('takes the whole note', () => {
    const made = parseBoardCreate({
      title: 'Add a garden',
      body: 'Through the doors.\r\n\r\n\r\nWith a fountain.',
      status: 'in_progress',
      color: 'green',
      labels: 'feature, garden',
      assigneeAgentId: 'agent-1',
    });
    assert.deepEqual(made, {
      title: 'Add a garden',
      body: 'Through the doors.\n\nWith a fountain.',
      status: 'in_progress',
      color: 'green',
      labels: ['feature', 'garden'],
      assigneeAgentId: 'agent-1',
    });
  });

  it('refuses what is not a note', () => {
    assert.equal(parseBoardCreate(null), null);
    assert.equal(parseBoardCreate('Add a garden'), null);
    assert.equal(parseBoardCreate({ title: '' }), null);
    assert.equal(parseBoardCreate({ title: 'x', status: 'blocked' }), null);
    assert.equal(parseBoardCreate({ title: 'x', color: 'teal' }), null);
    assert.equal(parseBoardCreate({ title: 'x', assigneeAgentId: 7 }), null);
  });

  it('never spreads what came in', () => {
    const made = parseBoardCreate({ title: 'x', __proto__: { evil: true }, extra: 1 });
    assert.ok(made);
    assert.equal('extra' in made, false);
    assert.equal('evil' in made, false);
  });
});

describe('what board_update accepts', () => {
  it('changes only what it names', () => {
    assert.deepEqual(parseBoardUpdate({ itemId: 'i1', status: 'done' }), {
      itemId: 'i1',
      status: 'done',
    });
    assert.deepEqual(parseBoardUpdate({ itemId: 'i1', assigneeAgentId: null }), {
      itemId: 'i1',
      assigneeAgentId: null,
    });
    assert.deepEqual(parseBoardUpdate({ itemId: 'i1', labels: ['a', 'A'] }), {
      itemId: 'i1',
      labels: ['a'],
    });
  });

  it('refuses a change into nonsense, and a change of nothing', () => {
    assert.equal(parseBoardUpdate({ itemId: 'i1' }), null, 'nothing to change');
    assert.equal(parseBoardUpdate({ status: 'done' }), null, 'no item');
    assert.equal(parseBoardUpdate({ itemId: 'i1', title: '  ' }), null, 'a blank title');
    assert.equal(parseBoardUpdate({ itemId: 'i1', status: 'later' }), null);
    assert.equal(parseBoardUpdate({ itemId: 'i1', body: 5 }), null);
    assert.equal(parseBoardUpdate({ itemId: 'i1', labels: 5 }), null);
  });
});

describe('who may touch the board', () => {
  const me = { userId: 'u1', role: 'member' as const };
  const admin = { userId: 'u2', role: 'admin' as const };
  const guest = { userId: 'u3', role: null };
  const mine = { createdBy: { kind: 'human' as const, id: 'u1' } };
  const byAgent = { createdBy: { kind: 'agent' as const, id: 'a1' } };
  const orphan = { createdBy: null };

  it('lets any member write, and a guest only read', () => {
    assert.equal(mayWriteBoard(me), true);
    assert.equal(mayWriteBoard(admin), true);
    assert.equal(mayWriteBoard(guest), false);
  });

  it('lets the author or an admin take a note down', () => {
    assert.equal(mayDeleteBoardItem(me, mine), true);
    assert.equal(mayDeleteBoardItem(me, byAgent), false, "somebody else's agent wrote it");
    assert.equal(mayDeleteBoardItem(me, orphan), false);
    assert.equal(mayDeleteBoardItem(admin, byAgent), true);
    assert.equal(mayDeleteBoardItem(admin, orphan), true);
    assert.equal(mayDeleteBoardItem(guest, mine), false);
  });

  it("lets only an agent's owner hand it a note, admins included", () => {
    const marvin = { ownerUserId: 'u1' };
    assert.equal(mayAssignBoardItem(me, marvin), true);
    assert.equal(mayAssignBoardItem(admin, marvin), false, 'an admin is not its owner');
    assert.equal(mayAssignBoardItem({ userId: 'u1', role: null }, marvin), false, 'a guest, even as owner');
  });
});

describe('which note a task is for', () => {
  const free = { number: 1, assignee: null };
  const mine = { number: 2, assignee: { id: 'a1' } };
  const theirs = { number: 3, assignee: { id: 'a2' } };

  it('takes a note nobody has, and keeps its own', () => {
    assert.equal(noteForTask(free, 'a1'), free);
    assert.equal(noteForTask(mine, 'a1'), mine);
  });

  it("leaves another agent's note alone", () => {
    assert.equal(noteForTask(theirs, 'a1'), null);
    assert.equal(noteForTask(null, 'a1'), null);
  });
});
