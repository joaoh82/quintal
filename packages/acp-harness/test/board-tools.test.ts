import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { noteNumber, startBridge } from '../src/mcp/bridge.js';

/**
 * The board tools, as the MCP server calls them.
 *
 * The model writes what a person would: `"#12"` for a note, `"bug, ui"` for
 * labels, a colleague by name. The bridge turns that into what the office
 * takes, refuses what the office would refuse without a round trip, and
 * passes the office's answer back whole — the hand-over line included, since
 * saying it is the agent's job.
 */

interface Seen {
  list: unknown[];
  get: unknown[];
  create: unknown[];
  update: unknown[];
}

function fakeGateway(scopes: string[], seen: Seen): Gateway {
  const note = { number: 14, title: 'Login redirect drops the return URL', assignee: null };
  return {
    ready: { scopes, boardVersion: 1, name: 'Bob' },
    boardList: async (query: unknown) => {
      seen.list.push(query);
      return { items: [note], agents: [], you: { agentId: 'a1', name: 'Bob' } };
    },
    boardGet: async (number: number) => {
      seen.get.push(number);
      return { item: note };
    },
    boardCreate: async (input: unknown) => {
      seen.create.push(input);
      return { item: note, handover: null };
    },
    boardUpdate: async (input: unknown) => {
      seen.update.push(input);
      return { item: { ...note, assignee: { id: 'a2', name: 'Arthur' } }, handover: '@Arthur board note #14 Login redirect drops the return URL is yours.' };
    },
  } as unknown as Gateway;
}

async function call(bridge: { url: string; token: string }, tool: string, args: Record<string, unknown>) {
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quintal-token': bridge.token },
    body: JSON.stringify({ tool, args }),
  });
  return (await response.json()) as { ok: boolean; result?: unknown; error?: string };
}

describe('a note number as people write it', () => {
  it('reads 12, "12" and "#12" alike, and refuses anything else', () => {
    assert.equal(noteNumber(12), 12);
    assert.equal(noteNumber('12'), 12);
    assert.equal(noteNumber(' #12 '), 12);
    assert.throws(() => noteNumber('twelve'), /not a note number/);
    assert.throws(() => noteNumber(0), /not a note number/);
    assert.throws(() => noteNumber(-3), /not a note number/);
    assert.throws(() => noteNumber(''), /not a note number/);
  });
});

describe('the board tools over the bridge', () => {
  it('turns what the model writes into what the office takes', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['board'], seen));
    try {
      const listed = await call(bridge, 'board_list', { status: 'open', mine: true });
      assert.equal(listed.ok, true);
      assert.deepEqual(seen.list, [{ status: 'open', mine: true }]);

      const everything = await call(bridge, 'board_list', { status: 'later' });
      assert.equal(everything.ok, true);
      assert.deepEqual(seen.list[1], {}, 'an unknown column is every column, not an error');

      const got = await call(bridge, 'board_get', { number: '#14' });
      assert.equal(got.ok, true);
      assert.deepEqual(seen.get, [14]);

      const created = await call(bridge, 'board_create', {
        title: 'Login redirect drops the return URL',
        body: 'Seen on staging.',
        labels: 'bug, auth',
      });
      assert.equal(created.ok, true);
      assert.deepEqual(seen.create, [
        { title: 'Login redirect drops the return URL', body: 'Seen on staging.', labels: ['bug', 'auth'] },
      ]);
      assert.equal(
        'assignee' in (seen.create[0] as Record<string, unknown>),
        false,
        'a note nobody was named for is left on the board, not handed to nobody explicitly',
      );

      const handed = await call(bridge, 'board_update', { number: 14, assignee: '@Arthur' });
      assert.equal(handed.ok, true);
      assert.deepEqual(seen.update, [{ number: 14, assignee: 'Arthur' }]);
      assert.match(
        String((handed.result as { handover: string }).handover),
        /^@Arthur board note #14 .* is yours\.$/,
        'the hand-over line comes back for the agent to say',
      );

      const taken = await call(bridge, 'board_update', { number: 14, assignee: null, status: 'done', labels: [] });
      assert.equal(taken.ok, true);
      assert.deepEqual(seen.update[1], { number: 14, assignee: null, status: 'done', labels: [] });
    } finally {
      await bridge.close();
    }
  });

  it('refuses what the office would refuse, before asking it', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['board'], seen));
    try {
      const untitled = await call(bridge, 'board_create', { body: 'no title' });
      assert.equal(untitled.ok, false);
      assert.match(untitled.error ?? '', /needs a title/);

      const empty = await call(bridge, 'board_update', { number: 14 });
      assert.equal(empty.ok, false);
      assert.match(empty.error ?? '', /say what changes/);

      const nonsense = await call(bridge, 'board_get', { number: 'the chair one' });
      assert.equal(nonsense.ok, false);
      assert.match(nonsense.error ?? '', /not a note number/);

      assert.deepEqual(seen.create, []);
      assert.deepEqual(seen.update, []);
      assert.deepEqual(seen.get, []);
    } finally {
      await bridge.close();
    }
  });

  it('says where the scope is granted when the agent has none', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['chat'], seen));
    try {
      for (const [tool, args] of [
        ['board_list', {}],
        ['board_get', { number: 1 }],
        ['board_create', { title: 'x' }],
        ['board_update', { number: 1, status: 'done' }],
      ] as const) {
        const refused = await call(bridge, tool, args as Record<string, unknown>);
        assert.equal(refused.ok, false, tool);
        assert.match(refused.error ?? '', /no "board" scope/);
        assert.match(refused.error ?? '', /Settings/);
      }
      assert.deepEqual(seen.list, []);
      assert.deepEqual(seen.create, []);
    } finally {
      await bridge.close();
    }
  });
});
