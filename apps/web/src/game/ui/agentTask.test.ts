import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { AgentTask } from '@quintal/shared';

// JSX here compiles to classic `React.createElement`; see approvalCard.test.ts.
(globalThis as unknown as { React: typeof React }).React = React;

/**
 * The task row on an agent's card: what it is on, which branch, and the pull
 * request as something you can click. When the agent is on nothing, nothing.
 */

const TASK: AgentTask = {
  title: 'fix the login redirect',
  repo: 'api',
  branch: 'quintal/marvin/fix-the-login-redirect',
};
const PR = { number: 12, url: 'https://github.com/acme/api/pull/12', state: 'open' as const };

async function render(task: AgentTask | null): Promise<string> {
  const { AgentTaskRow } = await import('./AgentTaskRow');
  return renderToStaticMarkup(createElement('dl', null, createElement(AgentTaskRow, { task })));
}

describe('the task on an agent card', () => {
  it('names the task, its branch and its pull request, as a link', async () => {
    const html = await render({ ...TASK, pr: PR });
    assert.match(html, /fix the login redirect/);
    assert.match(html, /quintal\/marvin\/fix-the-login-redirect/);
    assert.match(html, /<a href="https:\/\/github\.com\/acme\/api\/pull\/12"[^>]*target="_blank"[^>]*rel="noreferrer"[^>]*>PR #12<\/a>/);
    assert.match(html, /\(open\)/);
  });

  it('leaves the pull request out until there is one', async () => {
    const html = await render(TASK);
    assert.match(html, /quintal\/marvin\/fix-the-login-redirect/);
    assert.doesNotMatch(html, /<a /);
    assert.doesNotMatch(html, /PR #/);
  });

  it('renders nothing when the agent is on no task', async () => {
    assert.equal(await render(null), '<dl></dl>');
  });

  it('says the same thing in one line for the roster glyph', async () => {
    const { taskSummary } = await import('./AgentTaskRow');
    assert.equal(
      taskSummary({ ...TASK, pr: PR }),
      'On: fix the login redirect · quintal/marvin/fix-the-login-redirect · PR #12 (open)',
    );
    assert.equal(taskSummary(TASK), 'On: fix the login redirect · quintal/marvin/fix-the-login-redirect');
  });

  it('marks the roster row with a branch that names the task to a screen reader', async () => {
    const { TaskGlyph } = await import('./AgentTaskRow');
    const html = renderToStaticMarkup(createElement(TaskGlyph, { task: { ...TASK, pr: PR } }));
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="On: fix the login redirect · quintal\/marvin\/fix-the-login-redirect · PR #12 \(open\)"/);
    assert.match(html, /<svg/);
  });
});
