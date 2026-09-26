import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PublicApprovalRequest, PublicApprovalResolved } from '@quintal/shared';

import {
  EMPTY_APPROVALS,
  noteSent,
  receiveApproval,
  receiveResolution,
  type ApprovalState,
} from '../approvals';

// The app's tsconfig leaves JSX to Next (`jsx: "preserve"`), so the test
// runner's transform emits classic `React.createElement` calls. That contract
// wants a global `React`; give it one, then load the component. Nothing about
// the component changes — this is only how it is compiled here.
(globalThis as unknown as { React: typeof React }).React = React;

/**
 * What the card actually puts on screen.
 *
 * The rules it encodes are access rules — who is offered a control — so
 * "it renders" is not the interesting part. These pin that the buttons exist
 * for exactly one person and disappear the moment the question is over.
 */

const NOW = Date.now();
const ME = 'user-me';

function request(overrides: Partial<PublicApprovalRequest> = {}): PublicApprovalRequest {
  return {
    version: 1,
    requestId: 'req-1',
    turnId: 'turn-1',
    workerId: '0',
    sessionId: 'sess-1',
    channelId: 'ch-1',
    toolName: 'Bash',
    summary: 'pnpm build',
    options: [
      { id: 'allow_once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
    askedAt: NOW,
    expiresAt: NOW + 300_000,
    agentId: 'agent-1',
    agentName: 'Bob',
    ownerUserId: ME,
    ownerName: 'Josh',
    receivedAt: NOW,
    ...overrides,
  };
}

// Loaded after the global above is in place; the test runner's CJS output
// has no top-level await, so the import is awaited per render.
const render = async (
  approval: PublicApprovalRequest,
  approvals: ApprovalState,
  isOwner: boolean,
) => {
  const { ApprovalCard } = await import('./ApprovalCard');
  return renderToStaticMarkup(
    createElement(ApprovalCard, { approval, approvals, isOwner, onDecide: () => {} }),
  );
};

describe('the approval card on screen', () => {
  it('offers the owner Allow once and Deny, and says silence denies', async () => {
    const html = await render(request(), receiveApproval(EMPTY_APPROVALS, request()), true);
    assert.match(html, /Allow once/);
    assert.match(html, /Deny/);
    assert.match(html, /no answer denies it/);
    assert.match(html, /wants to run/);
    assert.match(html, /Bash/);
    assert.match(html, /pnpm build/, 'the action is shown, not just the tool');
    assert.match(html, /data-approval-state="waiting"/);
    // The attribute, not the `disabled:` Tailwind variant in the class list.
    assert.equal(/<button[^>]*\sdisabled(=|\s|>)/.test(html), false, 'the buttons work');
  });

  it('never offers a standing grant, even if one were smuggled in', async () => {
    const html = await render(request(), receiveApproval(EMPTY_APPROVALS, request()), true);
    assert.equal(/always/i.test(html), false);
  });

  it('says what the harness said the button grants, not "once" regardless', async () => {
    // The harness writes the label from the breadth and lifetime it has
    // established for the option it will actually take. A card that printed
    // its own "Allow once" would put the false promise back (QUIN-53).
    const broad = request({
      options: [
        { id: 'allow_once', label: 'Allow here, this session' },
        { id: 'deny', label: 'Deny' },
      ],
    });
    const html = await render(broad, receiveApproval(EMPTY_APPROVALS, broad), true);
    assert.match(html, /Allow here, this session/);
    assert.equal(/Allow once/.test(html), false);
  });

  it('offers Deny alone when the harness could not explain any allow', async () => {
    const denyOnly = request({ options: [{ id: 'deny', label: 'Deny' }] });
    const html = await render(denyOnly, receiveApproval(EMPTY_APPROVALS, denyOnly), true);
    assert.match(html, /Deny/);
    assert.equal(/Allow/.test(html), false, 'no allow button at all');
  });

  it('shows everyone else that the agent is waiting, with no controls', async () => {
    const html = await render(request(), receiveApproval(EMPTY_APPROVALS, request()), false);
    assert.match(html, /Waiting for Josh/);
    assert.equal(/<button/.test(html), false, 'nobody else is offered a button');
    assert.match(html, /Bash/, 'but the conversation still sees the agent is stopped');
  });

  it('disables the buttons while an answer is in flight', async () => {
    const state = noteSent(receiveApproval(EMPTY_APPROVALS, request()), 'req-1', 'allow_once');
    const html = await render(request(), state, true);
    assert.match(html, /<button[^>]*\sdisabled(=|\s|>)/, 'both buttons are held while it sends');
    assert.match(html, /sending…/);
    assert.match(html, /data-approval-state="sending"/);
  });

  it('replaces the buttons with the outcome once it is over', async () => {
    const resolved: PublicApprovalResolved = {
      version: 1, requestId: 'req-1', turnId: 'turn-1', resolution: 'denied',
      via: 'card', resolvedAt: NOW, agentId: 'agent-1', agentName: 'Bob', receivedAt: NOW,
    };
    const state = receiveResolution(receiveApproval(EMPTY_APPROVALS, request()), resolved);
    const html = await render(request(), state, true);
    assert.match(html, /Denied/);
    assert.equal(/<button/.test(html), false, 'no dead buttons');
    assert.match(html, /data-approval-state="resolved"/);
    assert.match(html, /asked to run/, 'and it reads as past tense');
  });

  it('offers nothing once the deadline has passed, with no word from anyone', async () => {
    const past = request({ expiresAt: NOW - 1 });
    const html = await render(past, receiveApproval(EMPTY_APPROVALS, past), true);
    assert.match(html, /No answer in time/);
    assert.equal(/<button/.test(html), false);
  });

  it('marks a private copy, so the chrome can keep it out of a transcript', async () => {
    const hidden = request({ private: true });
    const html = await render(hidden, receiveApproval(EMPTY_APPROVALS, hidden), true);
    assert.match(html, /data-approval-private="true"/);
  });

  it('offers its buttons again after its agent dropped and came back', async () => {
    const interrupted: PublicApprovalResolved = {
      version: 1, requestId: 'req-1', turnId: 'turn-1', resolution: 'interrupted',
      via: 'system', resolvedAt: NOW, agentId: 'agent-1', agentName: 'Bob', receivedAt: NOW,
    };
    let state = receiveResolution(receiveApproval(EMPTY_APPROVALS, request()), interrupted);
    const whileGone = await render(request(), state, true);
    assert.match(whileGone, /Interrupted/);
    assert.equal(/<button/.test(whileGone), false, 'no buttons at a dead socket');

    // The office re-sends the card once the agent is back.
    state = receiveApproval(state, request());
    const back = await render(request(), state, true);
    assert.match(back, /data-approval-state="waiting"/);
    assert.match(back, /Allow once/);
    assert.match(back, /Deny/);
    assert.equal(/<button[^>]*\sdisabled(=|\s|>)/.test(back), false, 'and they work');
  });

  it('says so plainly when the runtime named no action', async () => {
    const bare = request({ summary: '' });
    const html = await render(bare, receiveApproval(EMPTY_APPROVALS, bare), true);
    assert.match(html, /did not say what it would do/);
  });
});
