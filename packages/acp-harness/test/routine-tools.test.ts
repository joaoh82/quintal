import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gateway } from '../src/gateway/client.js';
import { localZone, routineName, startBridge } from '../src/mcp/bridge.js';

/**
 * The routine tools, as the MCP server calls them.
 *
 * The model names a routine as the list shows it and an agent as people do
 * (`@Marvin`, `me`), writes the schedule as a phrase, and never says a zone:
 * the bridge adds this machine's, so "9" means nine where the owner sits.
 * The bridge refuses without a round trip what the office would refuse (no
 * scope, nothing to change, no name) and hands the office's answer back whole.
 */

interface Seen {
  list: unknown[];
  get: unknown[];
  create: unknown[];
  update: unknown[];
  delete: unknown[];
}

function fakeGateway(scopes: string[], seen: Seen): Gateway {
  const hourly = {
    id: 'r-1',
    name: 'hourly PR check',
    agent: 'Marvin',
    schedule: 'every hour',
    when: 'every hour',
    tz: 'Europe/Lisbon',
    paused: false,
    nextDueAt: 1_000,
    lastRunAt: null,
    instructions: 'Review the open pull requests.',
    command: null,
    args: '',
    by: 'Josh, via Marvin',
    yours: true,
    updatedAt: 0,
  };
  return {
    ready: { scopes, routinesVersion: 1, name: 'Marvin' },
    routineList: async (input: unknown) => {
      seen.list.push(input);
      return { routines: [hourly] };
    },
    routineGet: async (input: unknown) => {
      seen.get.push(input);
      return { routine: hourly, runs: [{ dueAt: 500, outcome: 'fired', note: '', firedAt: 501 }] };
    },
    routineCreate: async (input: unknown) => {
      seen.create.push(input);
      return { routine: { ...hourly, name: 'deploy check', schedule: 'once, on 2 Nov 2026 at 09:00 (Europe/Lisbon)' } };
    },
    routineUpdate: async (input: unknown) => {
      seen.update.push(input);
      return { routine: { ...hourly, paused: true } };
    },
    routineDelete: async (input: unknown) => {
      seen.delete.push(input);
      return { deleted: true, name: hourly.name };
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

describe('a routine as the model names it', () => {
  it('takes a name or an id and refuses nothing at all', () => {
    assert.equal(routineName(' hourly PR check '), 'hourly PR check');
    assert.equal(routineName('r-1'), 'r-1');
    assert.throws(() => routineName(''), /name the routine/);
    assert.throws(() => routineName(undefined), /name the routine/);
  });
  it('reads the schedule in this machine’s zone, which Intl knows', () => {
    const zone = localZone();
    assert.ok(zone.length > 0);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-GB', { timeZone: zone }));
  });
});

describe('the routine tools over the bridge', () => {
  it('turns what the model writes into what the office takes, zone added', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [], delete: [] };
    const bridge = await startBridge(fakeGateway(['routines'], seen));
    try {
      const listed = await call(bridge, 'routine_list', {});
      assert.equal(listed.ok, true);
      assert.deepEqual(seen.list, [{}]);
      assert.deepEqual((listed.result as { routines: Array<{ name: string }> }).routines.map((routine) => routine.name), ['hourly PR check']);

      const ofOne = await call(bridge, 'routine_list', { agent: '@Arthur' });
      assert.equal(ofOne.ok, true);
      assert.deepEqual(seen.list[1], { agent: 'Arthur' });

      const got = await call(bridge, 'routine_get', { routine: 'hourly PR check' });
      assert.equal(got.ok, true);
      assert.deepEqual(seen.get, [{ routine: 'hourly PR check' }]);
      assert.equal((got.result as { runs: unknown[] }).runs.length, 1, 'the runs come back with it');

      const made = await call(bridge, 'routine_create', {
        name: 'deploy check',
        when: 'tomorrow at 9',
        agent: 'me',
        instructions: 'Check that the deploy went out.',
      });
      assert.equal(made.ok, true);
      assert.deepEqual(seen.create, [
        {
          name: 'deploy check',
          when: 'tomorrow at 9',
          tz: localZone(),
          agent: 'me',
          instructions: 'Check that the deploy went out.',
        },
      ]);
      assert.match((made.result as { routine: { schedule: string } }).routine.schedule, /^once, on/, 'the office’s reading comes back whole');

      const withCommand = await call(bridge, 'routine_create', { name: 'review sweep', when: 'every hour', command: '!Review', args: 'whatever is open' });
      assert.equal(withCommand.ok, true);
      assert.deepEqual(seen.create[1], { name: 'review sweep', when: 'every hour', tz: localZone(), command: 'review', args: 'whatever is open' });

      const paused = await call(bridge, 'routine_update', { routine: 'hourly PR check', paused: true });
      assert.equal(paused.ok, true);
      assert.deepEqual(seen.update, [{ routine: 'hourly PR check', paused: true }]);

      const rescheduled = await call(bridge, 'routine_update', { routine: 'r-1', when: 'weekdays at 9', command: null, new_name: 'weekday PR check' });
      assert.equal(rescheduled.ok, true);
      assert.deepEqual(seen.update[1], {
        routine: 'r-1',
        newName: 'weekday PR check',
        when: 'weekdays at 9',
        tz: localZone(),
        command: null,
      });

      const deleted = await call(bridge, 'routine_delete', { routine: 'hourly PR check', agent: 'Marvin' });
      assert.equal(deleted.ok, true);
      assert.deepEqual(seen.delete, [{ routine: 'hourly PR check', agent: 'Marvin' }]);
    } finally {
      await bridge.close();
    }
  });

  it('refuses before the office would: no scope, no name, no when, nothing to change', async () => {
    const seen: Seen = { list: [], get: [], create: [], update: [], delete: [] };
    const without = await startBridge(fakeGateway(['chat', 'commands'], seen));
    try {
      const refused = await call(without, 'routine_list', {});
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? '', /no "routines" scope/);
      assert.deepEqual(seen.list, []);
    } finally {
      await without.close();
    }

    const bridge = await startBridge(fakeGateway(['routines'], seen));
    try {
      const nothing = await call(bridge, 'routine_update', { routine: 'hourly PR check', agent: 'me' });
      assert.equal(nothing.ok, false);
      assert.match(nothing.error ?? '', /say what changes/);
      assert.deepEqual(seen.update, []);

      const nameless = await call(bridge, 'routine_get', {});
      assert.equal(nameless.ok, false);
      assert.match(nameless.error ?? '', /name the routine/);

      const whenless = await call(bridge, 'routine_create', { name: 'deploy check' });
      assert.equal(whenless.ok, false);
      assert.match(whenless.error ?? '', /say when/);
      assert.deepEqual(seen.create, []);
    } finally {
      await bridge.close();
    }
  });
});
