import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { segments } from './links.js';

/**
 * A pasted address in chat is meant to be opened. The transcript renders
 * text as text, so the split has to find exactly the addresses and hand
 * back everything else untouched — including the full stop after one.
 */

describe('where the links are in a line', () => {
  it('leaves a line with no address as it was', () => {
    assert.deepEqual(segments('back in five'), [{ kind: 'text', text: 'back in five' }]);
    assert.deepEqual(segments(''), []);
  });

  it('finds one, and does not take the sentence’s full stop with it', () => {
    assert.deepEqual(segments('see https://github.com/joaoh82/quintal/pull/76 for the diff.'), [
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        text: 'https://github.com/joaoh82/quintal/pull/76',
        href: 'https://github.com/joaoh82/quintal/pull/76',
      },
      { kind: 'text', text: ' for the diff.' },
    ]);
  });

  it('finds each of several on its own', () => {
    const found = segments('http://a.io/x, then https://b.io/y?z=1&w=2');
    assert.deepEqual(
      found.filter((s) => s.kind === 'link').map((s) => s.text),
      ['http://a.io/x', 'https://b.io/y?z=1&w=2'],
    );
    assert.deepEqual(found[1], { kind: 'text', text: ', then ' });
  });

  it('gives back prose punctuation, keeps the address’s own brackets', () => {
    const wrapped = segments('(see https://x.io/a)');
    assert.deepEqual(wrapped, [
      { kind: 'text', text: '(see ' },
      { kind: 'link', text: 'https://x.io/a', href: 'https://x.io/a' },
      { kind: 'text', text: ')' },
    ]);
    const wiki = segments('https://en.wikipedia.org/wiki/Foo_(bar)!');
    assert.equal(wiki[0]?.kind, 'link');
    assert.equal(wiki[0]?.text, 'https://en.wikipedia.org/wiki/Foo_(bar)');
    assert.deepEqual(wiki[1], { kind: 'text', text: '!' });
  });

  it('treats a bare www. as https', () => {
    assert.deepEqual(segments('try www.example.com/docs'), [
      { kind: 'text', text: 'try ' },
      { kind: 'link', text: 'www.example.com/docs', href: 'https://www.example.com/docs' },
    ]);
  });

  it('never makes a link out of another scheme', () => {
    for (const line of [
      'javascript:alert(1)',
      'data:text/html,<b>hi</b>',
      'file:///etc/passwd',
      'mailto:sam@example.com',
      'ftp://old.example.com',
    ]) {
      assert.deepEqual(segments(line), [{ kind: 'text', text: line }], line);
    }
  });

  it('wants something after the scheme, and a word boundary before www', () => {
    assert.deepEqual(segments('https:// alone'), [{ kind: 'text', text: 'https:// alone' }]);
    assert.deepEqual(segments('https://.'), [{ kind: 'text', text: 'https://.' }]);
    assert.deepEqual(segments('notwww.example.com'), [
      { kind: 'text', text: 'notwww.example.com' },
    ]);
  });

  it('stops at a quote or angle bracket, as prose does', () => {
    assert.deepEqual(segments('"https://x.io/a" <https://y.io/b>'), [
      { kind: 'text', text: '"' },
      { kind: 'link', text: 'https://x.io/a', href: 'https://x.io/a' },
      { kind: 'text', text: '" <' },
      { kind: 'link', text: 'https://y.io/b', href: 'https://y.io/b' },
      { kind: 'text', text: '>' },
    ]);
  });
});
