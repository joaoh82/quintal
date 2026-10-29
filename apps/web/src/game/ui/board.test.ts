import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardItemRef } from '@quintal/shared';

import { ageLabel, columnsOf, matchesFilter, nextStatus, taskBadgeOf, wallOf } from './board.js';

function note(number: number, extra: Partial<BoardItemRef> = {}): BoardItemRef {
  return {
    id: `i${number}`,
    number,
    title: `Note ${number}`,
    body: '',
    status: 'open',
    color: 'yellow',
    labels: [],
    assignee: null,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    task: null,
    ...extra,
  };
}

describe('the board, sorted for the panel', () => {
  const items = [
    note(3, { status: 'done' }),
    note(2, { status: 'in_progress' }),
    note(1),
  ];

  it('puts every note in its column, and has every column', () => {
    const columns = columnsOf(items);
    assert.deepEqual(Object.keys(columns), ['open', 'in_progress', 'done']);
    assert.deepEqual(columns.open.map((i) => i.number), [1]);
    assert.deepEqual(columns.in_progress.map((i) => i.number), [2]);
    assert.deepEqual(columns.done.map((i) => i.number), [3]);
    assert.deepEqual(columnsOf([]).done, []);
  });

  it('pins up what is not done, in progress first', () => {
    assert.deepEqual(wallOf(items).map((i) => i.number), [2, 1]);
  });

  it('moves a note one column along, and leaves done alone', () => {
    assert.equal(nextStatus('open'), 'in_progress');
    assert.equal(nextStatus('in_progress'), 'done');
    assert.equal(nextStatus('done'), null);
  });
});

describe('filtering notes', () => {
  const chair = note(12, {
    title: 'Fix the office chair',
    labels: ['bug', 'Furniture'],
    assignee: { id: 'a1', name: 'Marvin' },
  });

  it('matches nothing typed', () => {
    assert.equal(matchesFilter(chair, ''), true);
    assert.equal(matchesFilter(chair, '   '), true);
  });

  it('matches the number, a word of the title, a label, or who it is for', () => {
    assert.equal(matchesFilter(chair, '#12'), true);
    assert.equal(matchesFilter(chair, '12'), true);
    assert.equal(matchesFilter(chair, '1'), false, 'a number is whole');
    assert.equal(matchesFilter(chair, 'CHAIR'), true);
    assert.equal(matchesFilter(chair, 'furn'), true);
    assert.equal(matchesFilter(chair, 'marv'), true);
    assert.equal(matchesFilter(chair, 'tunnel'), false);
  });
});

describe('what a note\'s task says', () => {
  const task = { agent: { id: 'a1', name: 'Marvin' }, repo: 'office', branch: 'quintal/marvin/chair', pr: null, active: true };
  const pr = (state: 'open' | 'merged' | 'closed') => ({ number: 12, url: 'https://x/pull/12', state });

  it('is nothing until a task takes the note', () => {
    assert.equal(taskBadgeOf({ task: null }), null);
  });

  it('follows the pull request, and before one the branch', () => {
    assert.equal(taskBadgeOf({ task }), 'on a branch');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('open') } }), 'in review');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('merged'), active: false } }), 'merged');
    assert.equal(taskBadgeOf({ task: { ...task, pr: pr('closed'), active: false } }), 'closed');
  });

  it('says nothing of a task that ended without a pull request', () => {
    assert.equal(taskBadgeOf({ task: { ...task, active: false } }), null);
  });
});

describe('how old a note is', () => {
  it('reads coarsely', () => {
    const now = 1_000_000_000;
    assert.equal(ageLabel(now - 5_000, now), 'just now');
    assert.equal(ageLabel(now - 5 * 60_000, now), '5m ago');
    assert.equal(ageLabel(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(ageLabel(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(ageLabel(now + 60_000, now), 'just now', 'never in the future');
  });
});
