import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TeamRef } from '@quintal/shared';

// The test runner's transform emits classic `React.createElement` calls for
// the component's JSX; give them the global they expect.
(globalThis as unknown as { React: typeof React }).React = React;

const render = async (text: string, teams: TeamRef[] = []): Promise<string> => {
  const { Markdown } = await import('./Markdown');
  return renderToStaticMarkup(createElement(Markdown, { text, teams }));
};

const engineering: TeamRef = {
  id: 'team-1',
  name: 'engineering',
  members: [{ id: 'a1', name: 'Claude' }, { id: 'a2', name: 'Codex' }],
} as TeamRef;

describe('an agent reply as Markdown', () => {
  it('renders a table, a list, inline code and a fenced block', async () => {
    const html = await render(
      [
        '| file | change |',
        '| --- | --- |',
        '| a.ts | added |',
        '',
        '- one',
        '- two `x`',
        '',
        '```ts',
        'const y = 1;',
        '```',
      ].join('\n'),
    );
    assert.match(html, /<table/);
    assert.match(html, /<td[^>]*>a\.ts<\/td>/);
    assert.match(html, /<ul[^>]*>\n<li[^>]*>one<\/li>/);
    assert.match(html, /<code[^>]*>x<\/code>/);
    assert.match(html, /<pre[^>]*><code[^>]*>const y = 1;\n<\/code><\/pre>/);
  });

  it('keeps the number an ordered list starts at', async () => {
    const html = await render('4. Resume at step four\n5. Finish');
    assert.match(html, /<ol start="4"[^>]*>/);
    const fromOne = await render('1. one\n2. two');
    assert.doesNotMatch(fromOne, /start=/);
  });

  it('shows raw HTML as the text it was', async () => {
    const html = await render('look <script>alert(1)</script> and <img src=x onerror=alert(1)>');
    assert.doesNotMatch(html, /<script/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('opens http(s) links away from the office', async () => {
    const html = await render('see [the docs](https://example.com/a) or www.example.org');
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer"[^>]*>the docs<\/a>/,
    );
    assert.match(html, /<a href="http:\/\/www\.example\.org"[^>]*>www\.example\.org<\/a>/);
  });

  it('keeps only the words of a link to any other scheme', async () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<b>x</b>', '/settings', 'file:///etc/passwd']) {
      const html = await render(`[click me](${href})`);
      assert.doesNotMatch(html, /<a/, href);
      assert.doesNotMatch(html, /javascript|data:|file:/, href);
      assert.match(html, /click me/, href);
    }
  });

  it('never fetches an image: it becomes a link named by its alt text', async () => {
    const html = await render('![a chart](https://tracker.example/pixel.png)');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /<a href="https:\/\/tracker\.example\/pixel\.png"[^>]*>\[image: a chart\]<\/a>/);
    const unsafe = await render('![x](javascript:alert(1))');
    assert.doesNotMatch(unsafe, /<a|<img|javascript/);
    assert.match(unsafe, /\[image: x\]/);
  });

  it('renders an unclosed fence as code to the end, as a streaming reply has it', async () => {
    const html = await render('Here:\n\n```sh\nnpm test\n| not | a table |');
    assert.match(html, /<pre[^>]*><code[^>]*>npm test\n\| not \| a table \|/);
    assert.doesNotMatch(html, /<table/);
  });

  it('keeps single line breaks inside a paragraph', async () => {
    const html = await render('first line\nsecond line');
    assert.match(html, /<p class="[^"]*whitespace-pre-wrap[^"]*">first line\nsecond line<\/p>/);
  });

  it('shows an @team in prose as a chip and leaves one in code alone', async () => {
    const html = await render('ask @engineering, not `@engineering`', [engineering]);
    assert.match(html, /<span class="[^"]*text-amber-200" title="engineering: Claude and Codex">@engineering<\/span>/);
    assert.match(html, /<code[^>]*>@engineering<\/code>/);
    assert.equal(html.match(/title="engineering/g)?.length, 1);
  });
});
