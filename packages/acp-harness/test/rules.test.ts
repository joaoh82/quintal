import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentChatEvent } from '@quintal/shared';

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFleet, parseFleet, splitCommand, ConfigError } from '../src/config.js';
import { resolveZone } from '../src/mcp/bridge.js';
import { buildEnvelope, selectWindow, WINDOW_SIZE } from '../src/runner/context.js';
import { MAX_BUBBLES, MAX_POSTS, statusForTool, toBubbles, toPosts } from '../src/runner/outbound.js';
import { LOBBY_SCOPE, SessionStore } from '../src/runner/sessions.js';

/**
 * The rules from plan §2.9, tested directly. These encode product decisions —
 * how much context an agent gets, how loud it may be, when its session is
 * recycled — so they are worth pinning independently of any harness.
 */

describe('fleet config', () => {
  // cwd is validated now, so the fixture points at a directory that exists.
  const repo = mkdtempSync(join(tmpdir(), 'quintal-repo-'));
  const base = {
    url: 'http://localhost:3000',
    agents: [{ name: 'reviewer', key: 'qa_x', agent: 'claude-code', cwd: repo }],
  };

  it('resolves a known harness to its default command', () => {
    const fleet = parseFleet(base, '/base');
    assert.equal(fleet.agents[0]?.harness, 'claude-code');
    assert.ok(fleet.agents[0]?.command.join(' ').includes('claude-agent-acp'));
  });

  it('reads a key from the environment so it stays out of the file', () => {
    process.env.TEST_AGENT_KEY = 'qa_from_env';
    const fleet = parseFleet(
      { ...base, agents: [{ ...base.agents[0], key: undefined, keyEnv: 'TEST_AGENT_KEY' }] },
      '/base',
    );
    assert.equal(fleet.agents[0]?.key, 'qa_from_env');
    delete process.env.TEST_AGENT_KEY;
  });

  it('refuses an agent with no workspace', () => {
    // Not a nicety: code context comes from cwd, so an agent without one is an
    // agent working on whatever directory the CLI was launched from.
    assert.throws(
      () => parseFleet({ ...base, agents: [{ name: 'x', key: 'k', agent: 'goose' }] }, '/base'),
      ConfigError,
    );
  });

  it('refuses a custom harness with no command', () => {
    assert.throws(
      () => parseFleet({ ...base, agents: [{ name: 'x', key: 'k', agent: 'custom', cwd: repo }] }, '/base'),
      ConfigError,
    );
  });

  it('refuses duplicate agent names', () => {
    assert.throws(
      () => parseFleet({ ...base, agents: [base.agents[0], base.agents[0]] }, '/base'),
      /duplicate/,
    );
  });

  it('resolves a relative cwd against the config location', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-fleet-'));
    mkdirSync(join(dir, 'api'));

    const fleet = parseFleet({ ...base, agents: [{ ...base.agents[0], cwd: './api' }] }, dir);
    assert.equal(fleet.agents[0]?.cwd, join(dir, 'api'));
  });

  it('refuses a cwd that does not exist, naming what was written', () => {
    // The old failure was a bare ENOENT from spawn, seconds later, after the
    // office connection was already open.
    assert.throws(
      () => parseFleet({ ...base, agents: [{ ...base.agents[0], cwd: '/nope/missing' }] }, '/base'),
      /cwd "\/nope\/missing" does not exist/,
    );
  });

  it('reports the path it was given when --config is missing', () => {
    // Saying "looked for quintal.fleet.json in <cwd>" after being handed an
    // explicit path sends people hunting in the wrong directory.
    assert.throws(
      () => loadFleet('/definitely/not/here.json', '/base'),
      /no fleet config at \/definitely\/not\/here\.json/,
    );
  });

  it('resolves relative cwds against the config file, not the process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quintal-fleet-'));
    mkdirSync(join(dir, 'api'));
    writeFileSync(
      join(dir, 'quintal.fleet.json'),
      JSON.stringify({
        url: 'http://localhost:3000',
        agents: [{ name: 'a', key: 'qa_k', agent: 'goose', cwd: './api' }],
      }),
    );

    // Loaded from somewhere else entirely: "./api" must still mean the api
    // directory next to the config.
    const fleet = loadFleet(join(dir, 'quintal.fleet.json'), '/some/other/place');
    assert.equal(fleet.agents[0]?.cwd, join(dir, 'api'));
  });

  it('splits a command the way a shell would', () => {
    assert.deepEqual(splitCommand('npx -y some-acp --flag "two words"'), [
      'npx',
      '-y',
      'some-acp',
      '--flag',
      'two words',
    ]);
  });
});

describe('sessions', () => {
  it('keeps one session per zone', () => {
    const store = new SessionStore();
    store.put(LOBBY_SCOPE, 's1');
    store.put('focus', 's2');
    assert.equal(store.get(LOBBY_SCOPE)?.sessionId, 's1');
    assert.equal(store.get('focus')?.sessionId, 's2');
    assert.equal(store.size, 2);
  });

  it('evicts the least recently used past the cap', () => {
    const evicted: string[] = [];
    let clock = 0;
    const store = new SessionStore({
      max: 2,
      now: () => (clock += 1),
      onEvict: (record, reason) => evicted.push(`${record.scope}:${reason}`),
    });

    store.put('a', 's1');
    store.put('b', 's2');
    store.get('a'); // 'a' is now the most recent
    store.put('c', 's3');

    assert.deepEqual(evicted, ['b:lru']);
    assert.deepEqual(store.scopes().sort(), ['a', 'c']);
  });

  it('drops a scope on rotate', () => {
    const evicted: string[] = [];
    const store = new SessionStore({ onEvict: (r, reason) => evicted.push(reason) });
    store.put('focus', 's1');
    store.drop('focus', 'rotate');
    assert.equal(store.size, 0);
    assert.deepEqual(evicted, ['rotate']);
  });
});

describe('context envelope', () => {
  const message = (text: string, sentAt: number): AgentChatEvent => ({
    from: 's',
    fromUserId: 'u',
    fromName: 'Josh',
    fromKind: 'human',
    text,
    distance: 2,
    sentAt,
  });

  it('names the zone and the sender with their distance', () => {
    const envelope = buildEnvelope({
      agentName: 'reviewer',
      zoneLabel: 'the Agent Bay',
      triggers: [
        {
          fromUserId: 'u1',
          fromName: 'Josh',
          fromKind: 'human',
          text: 'how are the tests?',
          distance: 3,
          sentAt: 1,
        },
      ],
      window: [],
    });

    assert.match(envelope, /You are reviewer, in the Agent Bay/);
    assert.match(envelope, /Josh \(human, 3 tiles away\)/);
    assert.match(envelope, /how are the tests\?/);
  });

  it('marks a mention as coming from elsewhere, with no distance', () => {
    const envelope = buildEnvelope({
      agentName: 'reviewer',
      zoneLabel: 'the Agent Bay',
      triggers: [
        {
          fromUserId: 'u1',
          fromName: 'Josh',
          fromKind: 'human',
          text: 'reviewer, come here',
          distance: null,
          sentAt: 1,
        },
      ],
      window: [],
    });
    assert.match(envelope, /mentioned you from elsewhere/);
  });

  it('batches several triggers into one prompt', () => {
    const triggers = [1, 2, 3].map((n) => ({
      fromUserId: 'u1',
      fromName: 'Josh',
      fromKind: 'human' as const,
      text: `message ${n}`,
      distance: 1,
      sentAt: n,
    }));

    const envelope = buildEnvelope({
      agentName: 'reviewer',
      zoneLabel: 'the lobby',
      triggers,
      window: [],
    });

    assert.match(envelope, /3 messages for you:/);
    assert.match(envelope, /message 3/);
  });

  it('flags a steer so the agent does not re-answer itself', () => {
    const envelope = buildEnvelope({
      agentName: 'reviewer',
      zoneLabel: 'the lobby',
      triggers: [
        { fromUserId: 'u', fromName: 'Josh', fromKind: 'human', text: 'and also this', distance: 1, sentAt: 2 },
      ],
      window: [],
      steer: true,
    });
    assert.match(envelope, /\[new message — arrived while you were working\]/);
  });

  it('caps the pushed window and excludes the triggering messages', () => {
    const history = Array.from({ length: 30 }, (_, i) => message(`m${i}`, i));
    const window = selectWindow(history, new Set([29, 28]));

    assert.equal(window.length, WINDOW_SIZE);
    assert.ok(!window.some((m) => m.sentAt === 29 || m.sentAt === 28));
    // Newest kept, oldest dropped: the recent conversation, not the whole day.
    assert.equal(window.at(-1)?.text, 'm27');
  });
});

describe('speaking in an office', () => {
  it('keeps a short answer to one bubble', () => {
    assert.deepEqual(toBubbles('All 12 tests pass.'), ['All 12 tests pass.']);
  });

  it('never exceeds three bubbles, and says there is more', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the code.`).join(' ');
    const bubbles = toBubbles(long);

    assert.equal(bubbles.length, MAX_BUBBLES);
    assert.match(bubbles[MAX_BUBBLES - 1] ?? '', /continued — ask me for more/);
    for (const bubble of bubbles) assert.ok(bubble.length <= 280, `bubble too long: ${bubble.length}`);
  });

  it('says nothing when there is nothing to say', () => {
    assert.deepEqual(toBubbles('   '), []);
  });
});

describe('posting in a channel', () => {
  const review = [
    'Two findings on #52.',
    '',
    '1. `avatar.ts:166` — the balloon offset is applied before the sprite is scaled, so it lands over the neighbour.',
    '2. The emote sweep runs on every tick; a `Map` of expiries would do it once.',
    '3. `tickEmote` advances the frame from wall-clock time, so a tab left in the background jumps frames when it wakes.',
    '4. The CSS sprite and the Phaser sheet are the same PNG but sized separately; one constant would keep them aligned.',
    '',
    'Neither of the first two blocks the merge; the third is worth a follow-up.',
  ].join('\n');

  it('keeps a review whole — its lines, its list, its length', () => {
    assert.deepEqual(toPosts(review), [review]);
    assert.ok(review.length > 280, 'this would have been three bubbles');
  });

  it('splits at paragraphs only when the post will not fit', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}. ${'x'.repeat(90)}`);
    const posts = toPosts(paragraphs.join('\n\n'), 250);

    assert.ok(posts.length > 1);
    for (const post of posts) {
      assert.ok(post.length <= 250, `post too long: ${post.length}`);
      assert.match(post, /^Paragraph \d\./, 'every post starts on a paragraph, not mid-word');
    }
    assert.equal(posts.join('\n\n'), paragraphs.join('\n\n'), 'nothing was lost');
  });

  it('cuts a paragraph longer than a post rather than dropping it', () => {
    const wall = 'y'.repeat(600);
    const posts = toPosts(wall, 250);
    assert.equal(posts.join(''), wall);
  });

  it('stops at five posts and says there is more', () => {
    const endless = Array.from({ length: 40 }, (_, i) => `Item ${i}. ${'z'.repeat(200)}`).join('\n\n');
    const posts = toPosts(endless, 250);

    assert.equal(posts.length, MAX_POSTS);
    assert.match(posts[MAX_POSTS - 1] ?? '', /continued — ask me for more/);
    for (const post of posts) assert.ok(post.length <= 250, `post too long: ${post.length}`);
  });

  it('posts nothing when there is nothing to post', () => {
    assert.deepEqual(toPosts('  \n '), []);
  });

  it('turns tool calls into a glanceable status line', () => {
    assert.equal(statusForTool('Edit', { file_path: '/repo/src/auth.ts' }), 'editing auth.ts');
    assert.equal(statusForTool('Bash', { command: 'pnpm test' }), 'running pnpm test');
    // A shell tool is described by its command even when a path is also present.
    assert.equal(
      statusForTool('Bash', { command: 'pnpm test', file_path: '/repo/auth.ts' }),
      'running pnpm test',
    );
    assert.equal(statusForTool('Grep', { pattern: 'TODO' }), 'searching TODO');
    assert.ok(statusForTool('Edit', { file_path: '/a/b/c.ts' }).length <= 60);
  });
});

describe('walking somewhere', () => {
  const ZONES = [
    { id: 'agent-bay', label: 'Agent Bay', kind: 'agent_area' },
    { id: 'focus', label: 'Focus Room', kind: 'private' },
    { id: 'huddle', label: 'Huddle', kind: 'private' },
  ];

  it('takes a zone id', () => {
    assert.equal(resolveZone(ZONES, 'focus'), 'focus');
  });

  it('takes the human label, which is what somebody actually says', () => {
    assert.equal(resolveZone(ZONES, 'Focus Room'), 'focus');
    assert.equal(resolveZone(ZONES, 'agent bay'), 'agent-bay');
  });

  it('accepts a partial label — "the focus room" is one phrase to a person', () => {
    assert.equal(resolveZone(ZONES, 'Focus'), 'focus');
  });

  it('prefers an exact id over a label that merely contains it', () => {
    const zones = [
      { id: 'huddle', label: 'Huddle', kind: 'private' },
      { id: 'quiet', label: 'The huddle annex', kind: 'private' },
    ];
    assert.equal(resolveZone(zones, 'huddle'), 'huddle');
  });

  it('names the zones that do exist when asked for one that does not', () => {
    assert.throws(() => resolveZone(ZONES, 'the roof'), /Focus Room/);
  });

  it('refuses an empty request rather than picking one', () => {
    assert.throws(() => resolveZone(ZONES, '   '), /needs a zone/);
  });
});
