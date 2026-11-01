import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { commandName, startBridge } from '../src/mcp/bridge.js';

/**
 * The command tools, as the MCP server calls them.
 *
 * The model writes a command's name the way people type it — `!review`,
 * `Review` — and a default target by name. The bridge turns that into what
 * the office takes, refuses without a round trip what the office would
 * refuse (no scope, nothing to change), and hands the office's answer back
 * whole: the command as read, with whether it is the agent's to change.
 */

interface Seen {
  list: number;
  get: string[];
  create: unknown[];
  update: unknown[];
}

function fakeGateway(scopes: string[], seen: Seen): Gateway {
  const review = {
    name: 'review',
    summary: 'Review a pull request',
    argumentHint: '<pull request link>',
    instructions: 'Read the diff; say what would break.',
    usage: '!review @name <pull request link>',
    defaultTarget: null,
    by: 'Josh',
    yours: true,
    updatedAt: 0,
  };
  return {
    ready: { scopes, commandsVersion: 1, name: 'Marvin' },
    commandList: async () => {
      seen.list += 1;
      return { commands: [review] };
    },
    commandGet: async (name: string) => {
      seen.get.push(name);
      return { command: review };
    },
    commandCreate: async (input: unknown) => {
      seen.create.push(input);
      return { command: { ...review, name: 'triage', by: 'Josh, via Marvin' } };
    },
    commandUpdate: async (input: unknown) => {
      seen.update.push(input);
      return { command: { ...review, by: 'Josh, via Marvin' } };
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

describe('a command name as people write it', () => {
  it('reads "review", "!review" and " Review " alike, and refuses nothing at all', () => {
    assert.equal(commandName('review'), 'review');
    assert.equal(commandName('!review'), 'review');
    assert.equal(commandName(' Review '), 'review');
    assert.throws(() => commandName(''), /name the command/);
    assert.throws(() => commandName(undefined), /name the command/);
  });
});

describe('the command tools over the bridge', () => {
  it('turns what the model writes into what the office takes', async () => {
    const seen: Seen = { list: 0, get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['commands'], seen));
    try {
      const listed = await call(bridge, 'command_list', {});
      assert.equal(listed.ok, true);
      assert.equal(seen.list, 1);
      assert.deepEqual((listed.result as { commands: Array<{ name: string }> }).commands.map((command) => command.name), ['review']);

      const got = await call(bridge, 'command_get', { name: '!Review' });
      assert.equal(got.ok, true);
      assert.deepEqual(seen.get, ['review']);

      const made = await call(bridge, 'command_create', {
        name: '!triage',
        summary: 'Triage the board',
        argument_hint: '',
        instructions: 'Read the open notes; say which you could take.',
        default_target: '@me',
      });
      assert.equal(made.ok, true);
      assert.deepEqual(seen.create, [
        {
          name: 'triage',
          summary: 'Triage the board',
          argumentHint: '',
          instructions: 'Read the open notes; say which you could take.',
          defaultTarget: 'me',
        },
      ]);
      assert.equal((made.result as { command: { by: string } }).command.by, 'Josh, via Marvin', 'the office’s answer comes back whole');

      const changed = await call(bridge, 'command_update', { name: 'review', instructions: 'Read the whole diff.', default_target: null });
      assert.equal(changed.ok, true);
      assert.deepEqual(seen.update, [{ name: 'review', instructions: 'Read the whole diff.', defaultTarget: null }]);

      const renamed = await call(bridge, 'command_update', { name: 'review', new_name: '!Review-pr' });
      assert.equal(renamed.ok, true);
      assert.deepEqual(seen.update[1], { name: 'review', newName: 'review-pr' });
    } finally {
      await bridge.close();
    }
  });

  it('refuses before the office would: no scope, or nothing to change', async () => {
    const seen: Seen = { list: 0, get: [], create: [], update: [] };
    const without = await startBridge(fakeGateway(['chat'], seen));
    try {
      const refused = await call(without, 'command_list', {});
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? '', /no "commands" scope/);
      assert.equal(seen.list, 0);
    } finally {
      await without.close();
    }

    const bridge = await startBridge(fakeGateway(['commands'], seen));
    try {
      const nothing = await call(bridge, 'command_update', { name: 'review' });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error ?? '', /say what changes/);
      assert.deepEqual(seen.update, []);

      const nameless = await call(bridge, 'command_get', {});
      assert.equal(nameless.ok, false);
      assert.match(nameless.error ?? '', /name the command/);
    } finally {
      await bridge.close();
    }
  });
});
