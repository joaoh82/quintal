import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostBridge } from './host';
import { knownMachines, machineNaming, registerThisMachine } from './machine';

function hostThat(
  status:
    | { label: string; registered: boolean; knownAs?: string | null }
    | Error,
  remember: (token: string, label: string) => Promise<void> = async () => {},
): HostBridge {
  return {
    hostStatus: async () => {
      if (status instanceof Error) throw status;
      return status;
    },
    rememberHostToken: remember,
  } as unknown as HostBridge;
}

const ok = (token: string) =>
  (async () =>
    new Response(JSON.stringify({ token }), { status: 200 })) as unknown as typeof fetch;

const answering = (status: number, body: unknown = {}) =>
  (async () =>
    new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('deciding whether to ask for a name', () => {
  it('asks nothing in a browser', async () => {
    assert.equal((await machineNaming(null)).kind, 'settled');
  });

  /**
   * The one that keeps this from becoming a nag, and — more importantly — from
   * re-registering. A second registration revokes the first machine's token.
   */
  it('asks nothing once this machine holds a token', async () => {
    const prompt = await machineNaming(hostThat({ label: 'laptop', registered: true }));
    assert.equal(prompt.kind, 'settled');
  });

  it('offers the hostname as a default when nothing is registered', async () => {
    const prompt = await machineNaming(hostThat({ label: 'Joaos-MBP', registered: false }));
    assert.equal(prompt.kind, 'ask');
    assert.equal(prompt.kind === 'ask' ? prompt.suggested : '', 'Joaos-MBP');
  });

  it('does not ask when the keychain will not answer', async () => {
    const prompt = await machineNaming(hostThat(new Error('keychain is locked')));
    assert.equal(prompt.kind, 'failed');
  });

  /**
   * The bug this whole path exists to stop.
   *
   * A machine whose token this office rejected is unregistered, but it is not
   * anonymous — the app still remembers what it registered as, and that name is
   * what every agent assigned to it is waiting on. Asking "name this computer"
   * with the hostname in the field is how somebody ends up with two machines
   * and an idle fleet.
   */
  it('offers the name it was registered under, not the hostname', async () => {
    const prompt = await machineNaming(
      hostThat({ label: 'DPR010_Office', registered: false, knownAs: 'DPR010_Office' }),
    );

    assert.equal(prompt.kind, 'ask');
    assert.equal(prompt.kind === 'ask' ? prompt.suggested : '', 'DPR010_Office');
    assert.equal(
      prompt.kind === 'ask' ? prompt.knownAs : '',
      'DPR010_Office',
      'the prompt has to know this is a reclaim, so it can say so',
    );
  });

  it('knows a genuine first run from a machine that lost its token', async () => {
    const prompt = await machineNaming(hostThat({ label: 'Joaos-MBP', registered: false }));
    assert.equal(prompt.kind === 'ask' ? prompt.knownAs : 'unset', null);
  });
});

describe('the names this office already knows', () => {
  const answers = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  /**
   * The list somebody needs is the list that is empty under the old rule. Every
   * token revoked, four agents still pinned to `DPR010_Office`: the name that
   * brings the machine back exists, and the prompt has to offer it.
   */
  it('offers names with no live token, because those are the ones to reclaim', async () => {
    const machines = await knownMachines(
      answers({
        machines: [
          { label: 'DPR010_Office', registered: false, agents: 4 },
          { label: 'Work laptop', registered: true, agents: 0 },
        ],
      }),
    );

    assert.deepEqual(machines, [
      { label: 'DPR010_Office', registered: false, agents: 4 },
      { label: 'Work laptop', registered: true, agents: 0 },
    ]);
  });

  it('drops entries with no usable name rather than offering a blank button', async () => {
    const machines = await knownMachines(
      answers({ machines: [{ label: '' }, { agents: 2 }, 'DPR010_Office', null] }),
    );
    assert.deepEqual(machines, []);
  });

  it('fills in what an older office left out', async () => {
    const machines = await knownMachines(answers({ machines: [{ label: 'Laptop' }] }));
    assert.deepEqual(machines, [{ label: 'Laptop', registered: false, agents: 0 }]);
  });

  /** A worse prompt, not a broken one: nothing here may stop somebody naming a machine. */
  it('says nothing when the office will not answer', async () => {
    assert.deepEqual(await knownMachines(answers({ error: 'nope' }, 500)), []);
    assert.deepEqual(
      await knownMachines((async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
      [],
    );
  });
});

describe('claiming this machine under a chosen name', () => {
  it('does nothing in a browser', async () => {
    const outcome = await registerThisMachine('laptop', null, ok('qh_x'));
    assert.equal(outcome.kind, 'not-hosted');
  });

  it('registers under the name it was given, not the hostname', async () => {
    let sent: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)).label;
      return new Response(JSON.stringify({ token: 'qh_abc' }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await registerThisMachine(
      'Laptop',
      hostThat({ label: 'Joaos-MBP', registered: false }),
      fetchImpl,
    );

    assert.equal(outcome.kind, 'registered');
    assert.equal(sent, 'Laptop', 'the chosen name wins over the suggestion');
  });

  it('refuses an empty name rather than falling back to the hostname', async () => {
    let asked = false;
    const fetchImpl = (async () => {
      asked = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await registerThisMachine('   ', hostThat({ label: 'x', registered: false }), fetchImpl);

    assert.equal(outcome.kind, 'failed');
    assert.equal(asked, false, 'a nameless machine must not be registered');
  });

  it('keeps the token it was issued', async () => {
    let stored: string | null = null;
    const outcome = await registerThisMachine(
      'laptop',
      hostThat({ label: 'laptop', registered: false }, async () => {
        stored = 'called';
      }),
      ok('qh_abc'),
    );

    assert.equal(outcome.kind, 'registered');
    assert.equal(stored, 'called', 'the token is kept, not just fetched');
  });

  it('reports a guest refusal as a refusal, not a failure', async () => {
    const outcome = await registerThisMachine(
      'laptop',
      hostThat({ label: 'laptop', registered: false }),
      answering(403, { error: 'a guest session cannot register a machine' }),
    );

    assert.equal(outcome.kind, 'refused');
    assert.match(outcome.kind === 'refused' ? outcome.reason : '', /guest/);
  });

  it('does not store anything when the office refuses', async () => {
    let stored = false;
    const outcome = await registerThisMachine(
      'laptop',
      hostThat({ label: 'laptop', registered: false }, async () => {
        stored = true;
      }),
      answering(401, { error: 'sign in first' }),
    );

    assert.equal(outcome.kind, 'refused');
    assert.equal(stored, false);
  });

  it('says so when a token is issued but cannot be kept', async () => {
    const outcome = await registerThisMachine(
      'laptop',
      hostThat({ label: 'laptop', registered: false }, async () => {
        throw new Error('keychain is locked');
      }),
      ok('qh_abc'),
    );

    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.kind === 'failed' ? outcome.reason : '', /locked/);
  });

  it('treats an empty token as a failure rather than storing it', async () => {
    let stored = false;
    const outcome = await registerThisMachine(
      'laptop',
      hostThat({ label: 'laptop', registered: false }, async () => {
        stored = true;
      }),
      ok(''),
    );

    assert.equal(outcome.kind, 'failed');
    assert.equal(stored, false);
  });
});

describe('the name a machine keeps', () => {
  /**
   * A hostname follows the network; a machine's identity must not. Agents are
   * pinned to a machine by label, so re-deriving the name from the OS meant one
   * computer showing up twice and the fleet on the first one going quiet.
   */
  it('stores the chosen name alongside the token', async () => {
    let stored: { token: string; label: string } | null = null;
    const outcome = await registerThisMachine(
      'Laptop',
      hostThat({ label: 'Joaos-MBP-2.home', registered: false }, async (token, label) => {
        stored = { token, label };
      }),
      ok('qh_abc'),
    );

    assert.equal(outcome.kind, 'registered');
    assert.deepEqual(stored, { token: 'qh_abc', label: 'Laptop' });
  });
});
