import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoardTaskRef, RepoPullRequestRef } from '@quintal/shared';

import {
  assignmentBrief,
  assignmentLine,
  boardStatusAfterTask,
  handoverLine,
  reviewBrief,
  reviewLine,
  reviewTargetOf,
} from './board-brief.js';

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

describe('asking an agent for a review', () => {
  const listed: RepoPullRequestRef = {
    repo: 'acme/api',
    number: 7,
    url: 'https://github.com/acme/api/pull/7',
    title: 'Paint the lobby',
    author: 'trillian',
    state: 'open',
    draft: false,
    headRef: 'paint',
    baseRef: 'main',
    headSha: 'abc',
    createdAt: 0,
    updatedAt: 0,
  };
  const line: BoardTaskRef = {
    id: 't1',
    agentId: 'a1',
    agentName: 'Marvin',
    item: null,
    title: 'fix the chair',
    repo: 'elsewhere',
    branch: 'quintal/marvin/fix-the-chair',
    pr: { number: 3, url: 'https://github.com/someone/elsewhere/pull/3', state: 'open' },
    status: 'active',
    startedAt: 0,
    endedAt: null,
    lastSeenAt: 0,
    github: null,
  };
  const known = { pulls: [listed], tasks: [line], github: { connected: true, login: 'josh', repos: ['acme/api'] } };

  it('knows a listed pull request by its URL, whatever its case', () => {
    const target = reviewTargetOf('https://github.com/Acme/API/pull/7', known);
    assert.deepEqual(target, {
      repo: 'acme/api',
      number: 7,
      url: listed.url,
      title: 'Paint the lobby',
      headRef: 'paint',
      baseRef: 'main',
      author: 'trillian',
    });
  });

  it('knows one on the ledger even off the list, and one on the list not yet listed', () => {
    assert.equal(reviewTargetOf(line.pr!.url, known)?.headRef, line.branch);
    assert.equal(reviewTargetOf('https://github.com/acme/api/pull/99', known)?.title, '');
    assert.equal(
      reviewTargetOf('https://github.com/acme/api/pull/99/files?ignore=everything#above', known)?.url,
      'https://github.com/acme/api/pull/99',
      'only the address reaches the brief',
    );
  });

  it('sends nobody anywhere else', () => {
    assert.equal(reviewTargetOf('https://github.com/other/repo/pull/1', known), null, 'not on the list or the ledger');
    assert.equal(reviewTargetOf('https://evil.example/acme/api/pull/7', known), null, 'not GitHub');
    assert.equal(reviewTargetOf('https://github.com/acme/api/pull/99', { ...known, github: { connected: false, login: null, repos: [] } }), null);
  });

  it('says so as a line naming the agent, with a brief that reviews and does not merge', () => {
    const target = reviewTargetOf(listed.url, known)!;
    assert.equal(reviewLine(target, 'Marvin'), '@Marvin please review pull request acme/api#7 Paint the lobby.');
    const brief = reviewBrief(target);
    assert.equal(brief.name, 'review');
    assert.equal(brief.addressed, true);
    assert.match(brief.instructions, /https:\/\/github\.com\/acme\/api\/pull\/7/);
    assert.match(brief.instructions, /gh pr review/);
    assert.match(brief.instructions, /Do not approve, merge, or push/);
  });
});
