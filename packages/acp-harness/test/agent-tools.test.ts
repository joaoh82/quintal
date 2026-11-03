import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { startBridge } from '../src/mcp/bridge.js';

/**
 * The agent tools, as the MCP server calls them.
 *
 * The model names an agent as people do (`@Marvin`, `me`) and the fields with
 * underscores; the bridge turns that into what the office takes, keeps the
 * difference between "not given" and "back to the default", and refuses
 * without a round trip what the office would refuse. The rules on who may
 * give what are the office's, and tested there.
 */

interface Seen {
  list: unknown[];
  get: unknown[];
  create: unknown[];
  update: unknown[];
}

function fakeGateway(scopes: string[], seen: Seen): Gateway {
  const bob = { id: 'a-2', name: 'Bob', yours: true };
  return {
    ready: { scopes, agentsVersion: 1, name: 'Marvin' },
    agentList: async (input: unknown) => {
      seen.list.push(input);
      return { agents: [bob], machines: [{ label: 'laptop', lastSeenAt: null, runtimes: [] }] };
    },
    agentGet: async (input: unknown) => {
      seen.get.push(input);
      return { agent: bob };
    },
    agentCreate: async (input: unknown) => {
      seen.create.push(input);
      return { agent: bob, note: 'Bob starts on laptop.' };
    },
    agentUpdate: async (input: unknown) => {
      seen.update.push(input);
      return { agent: bob, note: 'Bob restarts on laptop.' };
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

describe('the agent tools over the bridge', () => {
  it('turns what the model writes into what the office takes', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['agents'], seen));
    try {
      const listed = await call(bridge, 'agent_list', {});
      assert.equal(listed.ok, true);
      assert.deepEqual(seen.list, [{}]);
      assert.deepEqual((listed.result as { machines: Array<{ label: string }> }).machines.map((machine) => machine.label), ['laptop']);

      await call(bridge, 'agent_list', { mine: true });
      assert.deepEqual(seen.list[1], { mine: true });

      await call(bridge, 'agent_get', {});
      await call(bridge, 'agent_get', { agent: '@Bob' });
      assert.deepEqual(seen.get, [{}, { agent: 'Bob' }]);

      const made = await call(bridge, 'agent_create', {
        name: ' Bob ',
        description: 'Reviews.',
        instructions: 'Be terse.',
        scopes: ['chat', 'dm'],
        machine: 'laptop',
        runtime: 'claude-code',
        max_sessions: 2,
      });
      assert.equal(made.ok, true);
      assert.deepEqual(seen.create, [
        {
          name: 'Bob',
          description: 'Reviews.',
          instructions: 'Be terse.',
          scopes: ['chat', 'dm'],
          machine: 'laptop',
          runtime: 'claude-code',
          maxSessions: 2,
        },
      ]);
      assert.equal((made.result as { note: string }).note, 'Bob starts on laptop.', 'the office\'s note comes back whole');

      await call(bridge, 'agent_update', { agent: '@Bob', new_name: 'Robert', character: 'hugo', enabled: false });
      assert.deepEqual(seen.update[0], { agent: 'Bob', newName: 'Robert', character: 'hugo', enabled: false });
    } finally {
      await bridge.close();
    }
  });

  it('keeps "back to the default" apart from "not given"', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const bridge = await startBridge(fakeGateway(['agents'], seen));
    try {
      await call(bridge, 'agent_update', { agent: 'Bob', machine: null, model: null, max_sessions: null });
      assert.deepEqual(seen.update[0], { agent: 'Bob', machine: null, model: null, maxSessions: null });

      await call(bridge, 'agent_update', { agent: 'Bob', scopes: [] });
      assert.deepEqual(seen.update[1], { agent: 'Bob', scopes: [] }, 'an empty list is a list');

      await call(bridge, 'agent_create', { name: 'Unrun', machine: null });
      assert.deepEqual(seen.create[0], { name: 'Unrun', machine: null });
    } finally {
      await bridge.close();
    }
  });

  it('refuses before the office would: no scope, no name, no target, nothing to change', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [] };
    const without = await startBridge(fakeGateway(['chat', 'routines'], seen));
    try {
      for (const tool of ['agent_list', 'agent_get', 'agent_create', 'agent_update']) {
        const refused = await call(without, tool, { name: 'Bob', agent: 'Bob' });
        assert.equal(refused.ok, false, tool);
        assert.match(refused.error ?? '', /no "agents" scope/, tool);
      }
      assert.deepEqual(seen, { list: [], get: [], create: [], update: [] });
    } finally {
      await without.close();
    }

    const bridge = await startBridge(fakeGateway(['agents'], seen));
    try {
      const nameless = await call(bridge, 'agent_create', { name: '  ' });
      assert.equal(nameless.ok, false);
      assert.match(nameless.error ?? '', /give the agent a name/);

      const nobody = await call(bridge, 'agent_update', { enabled: false });
      assert.equal(nobody.ok, false);
      assert.match(nobody.error ?? '', /say which agent/, 'changing yourself is something you say');

      const nothing = await call(bridge, 'agent_update', { agent: 'Bob' });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error ?? '', /say what changes/);
      assert.deepEqual(seen.update, []);
    } finally {
      await bridge.close();
    }
  });
});
