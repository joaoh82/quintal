import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHOSEN_EMOTES,
  EMOTE_FRAMES,
  EMOTE_IDS,
  emoteForStatus,
  emoteFrames,
  isEmote,
} from './emotes.js';

/**
 * The balloon catalogue and the table that picks one from a status line.
 *
 * The table is the point: every state the harness narrates gets a balloon or
 * deliberately none, and adding a state is adding a row. A status that fell
 * through to the wrong glyph would show an agent as working while it waits.
 */

describe('the emote catalogue', () => {
  it('has one frame per id, in sheet order, with no duplicates', () => {
    assert.equal(new Set(EMOTE_FRAMES).size, EMOTE_FRAMES.length);
    for (const id of EMOTE_IDS) {
      const frames = emoteFrames(id);
      assert.ok(frames.length > 0, `${id} has a frame`);
      for (const frame of frames) assert.ok(frame >= 0 && frame < EMOTE_FRAMES.length);
    }
  });

  it('animates thinking over the three dot frames', () => {
    assert.deepEqual(emoteFrames('dots'), [0, 1, 2]);
  });

  it('never lets the model choose a balloon the harness derives', () => {
    for (const id of CHOSEN_EMOTES) {
      assert.ok(isEmote(id));
      assert.notEqual(id, 'dots', 'a chosen "thinking" would make an idle agent look busy');
      assert.notEqual(id, 'question');
      assert.notEqual(id, 'cross');
      assert.notEqual(id, 'sleep');
    }
  });

  it('refuses anything that is not a catalogue id', () => {
    assert.equal(isEmote('happy'), true);
    assert.equal(isEmote('dots1'), false, 'a frame is not an id');
    assert.equal(isEmote('<img>'), false);
    assert.equal(isEmote(42), false);
  });
});

describe('the balloon a status implies', () => {
  const table: Array<[string, string]> = [
    ['', ''],
    ['idle', ''],
    ['thinking', 'dots'],
    ['waiting for Josh', 'question'],
    ['no model "opus" here', 'cross'],
    ['offline', 'alert'],
    ['reading src/index.ts', 'idea'],
    ['running git status', 'idea'],
    // A test run is a wait: the thinking balloon, as for "thinking".
    ['running pnpm test', 'dots'],
    ['running cd apps/web && pnpm test', 'dots'],
    ['running vitest run', 'dots'],
    ['running pnpm --filter @quintal/web test', 'dots'],
    ['running pnpm -r test', 'dots'],
    ['running npx vitest', 'dots'],
    ['running cargo test -p api', 'dots'],
    ['running git add foo.test.ts', 'idea'],
    ['running git commit -m "add tests"', 'idea'],
    ['running git commit -m "fix && jest"', 'idea'],
    ['running pnpm add vitest', 'idea'],
    // Only a shell command is a test run: a search or an edit is what it says it is.
    ['searching && jest', 'idea'],
    ['searching && pnpm test', 'idea'],
    ['editing foo&&jest.ts', 'idea'],
    ['fetching https://x.test/?q=%26%26 pytest', 'idea'],
  ];

  for (const [status, expected] of table) {
    it(`${JSON.stringify(status)} → ${expected || 'nothing'}`, () => {
      assert.equal(emoteForStatus(status), expected);
    });
  }
});
