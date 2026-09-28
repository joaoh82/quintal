import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ActivityItem, PublicActivity } from '@quintal/shared';

import { Speech } from './speech';

const item = (id: string, text: string, state: ActivityItem['state'] = 'success'): ActivityItem => ({
  id,
  kind: 'message',
  text,
  state,
  startedAt: 0,
});

const activity = (over: Partial<PublicActivity> = {}): PublicActivity => ({
  version: 1,
  turnId: 't1',
  workerId: '0',
  sessionId: 's',
  requestId: 'r',
  sequence: 1,
  state: 'running',
  startedAt: 0,
  updatedAt: 0,
  items: [],
  agentId: 'agent-1',
  agentName: 'Arthur',
  receivedAt: 0,
  zoneId: 'agent-bay',
  nearby: true,
  ...over,
});

describe('speech from activity', () => {
  it('says a line once it is finished, and only once', () => {
    const speech = new Speech();
    assert.equal(speech.next(activity({ items: [] })), null);
    assert.equal(speech.next(activity({ items: [item('m1', 'Half a sent', 'running')] })), null);

    const said = speech.next(activity({ items: [item('m1', 'On it — pulling the branch now.')] }));
    assert.deepEqual(said, { agentId: 'agent-1', text: 'On it — pulling the branch now.' });

    // The same update arriving again must not put the line up a second time.
    assert.equal(speech.next(activity({ items: [item('m1', 'On it — pulling the branch now.')] })), null);
  });

  it('says the newest line when several finish at once', () => {
    const speech = new Speech();
    speech.next(activity({ items: [] }));
    const said = speech.next(
      activity({ items: [item('m1', 'On it.'), item('m2', 'Done — the tree is clean.')] }),
    );
    assert.equal(said?.text, 'Done — the tree is clean.');
  });

  /**
   * The case that makes this worth a class rather than a filter: joining, or
   * walking into earshot, halfway through somebody else's turn.
   */
  it('stays quiet about what was said before we were listening', () => {
    const speech = new Speech();
    const already = [item('m1', 'Said before you got here.')];
    assert.equal(speech.next(activity({ items: already })), null);

    const said = speech.next(activity({ items: [...already, item('m2', 'Said while you watched.')] }));
    assert.equal(said?.text, 'Said while you watched.');
  });

  it('says nothing for a channel post or from out of earshot', () => {
    const items = [item('m1', 'Reviewed the PR.')];
    const channel = new Speech();
    channel.next(activity({ channelId: 'c1', nearby: false, items: [] }));
    assert.equal(channel.next(activity({ channelId: 'c1', nearby: false, items })), null);

    const far = new Speech();
    far.next(activity({ nearby: false, items: [] }));
    assert.equal(far.next(activity({ nearby: false, items })), null);
  });

  it('keeps separate turns apart', () => {
    const speech = new Speech();
    speech.next(activity({ turnId: 'a', items: [] }));
    speech.next(activity({ turnId: 'b', items: [] }));
    assert.equal(speech.next(activity({ turnId: 'a', items: [item('m1', 'From A.')] }))?.text, 'From A.');
    assert.equal(speech.next(activity({ turnId: 'b', items: [item('m1', 'From B.')] }))?.text, 'From B.');
  });

  it('cuts a long answer down to something that fits over a head', () => {
    const speech = new Speech();
    speech.next(activity({ items: [] }));
    const long = `${'The map is 56 by 46 tiles. '.repeat(20)}`;
    const said = speech.next(activity({ items: [item('m1', long)] }));
    assert.ok(said);
    assert.ok(said.text.length <= 280, `bubble was ${said.text.length} characters`);
    assert.ok(said.text.endsWith('…'));
  });
});
