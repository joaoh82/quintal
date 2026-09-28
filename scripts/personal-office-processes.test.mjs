import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { alive, listenerPid, listeners, parseLsof, parseSs, rssMb } from './personal-office-processes.mjs';

test('macOS machine output retains every listening address and its owner', () => {
  assert.deepEqual(parseLsof('p421\nn127.0.0.1:43123\np422\nn*:43123\nn[::1]:43123\n'), [
    { pid: 421, address: '127.0.0.1:43123' },
    { pid: 422, address: '*:43123' },
    { pid: 422, address: '[::1]:43123' },
  ]);
  assert.deepEqual(parseLsof(''), []);
});

test('Linux ss retains IPv4, IPv6, wildcard and unidentified listeners', () => {
  assert.deepEqual(parseSs([
    'LISTEN 0 511 127.0.0.1:43123 0.0.0.0:* users:(("quintal-node",pid=421,fd=28))',
    'LISTEN 0 511 0.0.0.0:43123 0.0.0.0:*',
    'LISTEN 0 511 [::1]:43123 [::]:* users:(("node",pid=422,fd=28))',
    'LISTEN 0 511 *:43123 *:* users:(("node",pid=423,fd=28),("node",pid=424,fd=28))',
  ].join('\n')), [
    { pid: 421, address: '127.0.0.1:43123' },
    { pid: null, address: '0.0.0.0:43123' },
    { pid: 422, address: '[::1]:43123' },
    { pid: 423, address: '*:43123' },
    { pid: 424, address: '*:43123' },
  ]);
  assert.deepEqual(parseSs(''), []);
  assert.throws(() => parseSs('unexpected output'), /Unrecognized/);
});

test('only one positive, identified PID may be signalled', () => {
  for (const pids of [[], [null], [0], [1], [-4], [NaN], [421, 422], [421, null]]) {
    assert.throws(() => listenerPid(pids.map((pid) => ({ pid }))), /identifiable/);
  }
  assert.equal(listenerPid([{ pid: 421 }, { pid: 421 }]), 421);
});

test('tool errors cannot become successful shutdown evidence', () => {
  const missing = () => { throw Object.assign(new Error('missing tool'), { code: 'ENOENT' }); };
  assert.throws(() => listeners(43123, 'linux', missing), /missing tool/);
  assert.throws(() => listeners(43123, 'darwin', missing), /missing tool/);
  const empty = () => { throw Object.assign(new Error('no matches'), { status: 1, stdout: '', stderr: '' }); };
  assert.deepEqual(listeners(43123, 'darwin', empty), []);
  assert.throws(() => listeners(43123, 'linux', empty), /no matches/);
  const denied = () => { throw Object.assign(new Error('denied'), { status: 1, stderr: 'permission denied' }); };
  assert.throws(() => listeners(43123, 'darwin', denied), /denied/);
});

test('restart polling tolerates the ownerless socket left briefly after SIGKILL', () => {
  const closing = parseSs('LISTEN 0 511 127.0.0.1:43123 0.0.0.0:*');
  assert.throws(() => listenerPid(closing), /identifiable/);
  assert.equal(listenerPid(closing, { required: false }), null);
  assert.equal(listenerPid([], { required: false }), null);
  const restarted = parseSs('LISTEN 0 511 127.0.0.1:43123 0.0.0.0:* users:(("node",pid=422,fd=28))');
  assert.equal(listenerPid(restarted, { required: false }), 422);
});

test('Windows explicitly skips before loading workspace dependencies or launching an app', () => {
  const smoke = new URL('./personal-office-smoke.mjs', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    `Object.defineProperty(process, 'platform', { value: 'win32' }); await import(${JSON.stringify(smoke)});`,
  ], { encoding: 'utf8' });
  assert.match(output, /SKIP:.*Windows.*Unix signals and listener inspection/);
});

test('host inspection finds a real loopback listener and observes its close', {
  skip: !['darwin', 'linux'].includes(process.platform),
}, async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const sockets = listeners(port);
    assert.equal(listenerPid(sockets), process.pid);
    assert.ok(sockets.every(({ address }) => address === `127.0.0.1:${port}`));
    assert.equal(alive(process.pid), true);
    assert.ok(rssMb(process.pid) > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(listeners(port), []);
});
