import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignmentBrief, assignmentLine, boardStatusAfterTask, handoverLine } from './board-brief.js';

const chair = { number: 12, title: 'Fix the chair', body: 'It clips through the desk.', labels: ['bug', 'furniture'] };

describe('handing a note to an agent', () => {
  it('says so as a line that names the agent, which is what reaches it', () => {
    assert.equal(assignmentLine(chair, 'Marvin'), '@Marvin board note #12 Fix the chair is yours.');
  });

  it('tells whoever had it before where it went', () => {
    assert.equal(handoverLine(chair, 'Arthur', 'Marvin'), '@Arthur board note #12 Fix the chair has gone to Marvin.');
    assert.equal(handoverLine(chair, 'Arthur', null), '@Arthur board note #12 Fix the chair is no longer yours.');
  });

  it('attaches a brief the agent reads as being asked, with the note and how the board follows', () => {
    const brief = assignmentBrief(chair);
    assert.equal(brief.name, 'board');
    assert.equal(brief.args, '#12');
    assert.equal(brief.addressed, true);
    assert.match(brief.instructions, /note #12 from the office board: Fix the chair/);
    assert.match(brief.instructions, /Labels: bug, furniture/);
    assert.match(brief.instructions, /It clips through the desk\./);
    assert.match(brief.instructions, /task_begin and pass item 12/);
    assert.match(brief.instructions, /Report here/);
  });

  it('leaves out what the note does not have', () => {
    const bare = assignmentBrief({ number: 3, title: 'Water the plants', body: '  ', labels: [] });
    assert.doesNotMatch(bare.instructions, /Labels:/);
    assert.match(bare.instructions, /Water the plants\n\nIf this changes/);
  });
});

describe('where a note goes when its task is heard', () => {
  it('moves an open note to in progress when a task first takes it', () => {
    assert.equal(boardStatusAfterTask({ status: 'open' }, { linked: true, merged: false }), 'in_progress');
  });

  it('moves a note to done when the pull request merged, from wherever it was', () => {
    assert.equal(boardStatusAfterTask({ status: 'open' }, { linked: true, merged: true }), 'done');
    assert.equal(boardStatusAfterTask({ status: 'in_progress' }, { linked: false, merged: true }), 'done');
    assert.equal(boardStatusAfterTask({ status: 'done' }, { linked: false, merged: true }), null, 'already there');
  });

  it('never moves a note back, and leaves alone a task said again', () => {
    assert.equal(boardStatusAfterTask({ status: 'in_progress' }, { linked: true, merged: false }), null);
    assert.equal(boardStatusAfterTask({ status: 'done' }, { linked: true, merged: false }), null, 'a person moved it; it stays');
    assert.equal(boardStatusAfterTask({ status: 'open' }, { linked: false, merged: false }), null);
  });
});
