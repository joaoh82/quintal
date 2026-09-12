import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReadReports, type ReadSink } from './readReports';

function sink(): ReadSink & { sent: Array<[string, number]> } {
  const sent: Array<[string, number]> = [];
  return { sent, markRead: (channelId, at) => void sent.push([channelId, at]) };
}

describe('telling the office where you have read to', () => {
  it('reports a channel once, and not again for the same place', () => {
    const reports = new ReadReports();
    const office = sink();

    assert.equal(reports.queue({ 'channel:a': 5_000 }), true);
    reports.flush(office);
    assert.deepEqual(office.sent, [['a', 5_000]]);

    // The same cursor, offered again: nothing new to say.
    assert.equal(reports.queue({ 'channel:a': 5_000 }), false);
    reports.flush(office);
    assert.deepEqual(office.sent, [['a', 5_000]], 'still just the one');

    // Read further: that is news.
    assert.equal(reports.queue({ 'channel:a': 9_000 }), true);
    reports.flush(office);
    assert.deepEqual(office.sent, [
      ['a', 5_000],
      ['a', 9_000],
    ]);
  });

  it('leaves zones and nearby alone: the office keeps nothing for them', () => {
    const reports = new ReadReports();
    const office = sink();

    assert.equal(reports.queue({ nearby: 5_000, 'zone:focus': 5_000 }), false);
    reports.flush(office);
    assert.deepEqual(office.sent, []);
  });

  /**
   * The bug this class exists to make impossible.
   *
   * A flush falling in a reconnect gap used to take the pending reports with
   * it: cleared before the session was checked, and nothing re-queued them
   * until the person happened to read something else. Meanwhile the other
   * machine — the whole reason the cursor is on the server — kept its dot.
   */
  it('keeps what it could not send, and sends it when the office is back', () => {
    const reports = new ReadReports();
    const office = sink();

    reports.queue({ 'channel:a': 5_000, 'channel:b': 6_000 });
    assert.equal(reports.flush(null), true, 'still waiting, so come back for it');
    assert.equal(reports.waiting, 2);

    assert.equal(reports.flush(office), false);
    assert.deepEqual(office.sent.sort(), [
      ['a', 5_000],
      ['b', 6_000],
    ]);
    assert.equal(reports.waiting, 0);
  });

  it('does not count an unsent cursor as reported', () => {
    const reports = new ReadReports();
    const office = sink();

    reports.queue({ 'channel:a': 5_000 });
    reports.flush(null);

    // Offering the same cursor again must not be swallowed as "already told
    // them" — nobody was told anything.
    assert.equal(reports.queue({ 'channel:a': 5_000 }), true);
    reports.flush(office);
    assert.deepEqual(office.sent, [['a', 5_000]]);
  });

  it('sends only the furthest place read while it was waiting', () => {
    const reports = new ReadReports();
    const office = sink();

    reports.queue({ 'channel:a': 1_000 });
    reports.queue({ 'channel:a': 2_000 });
    reports.queue({ 'channel:a': 3_000 });
    reports.flush(office);

    assert.deepEqual(office.sent, [['a', 3_000]], 'one message, not three');
  });
});
