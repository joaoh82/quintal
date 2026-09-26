'use client';

import type { ApprovalOptionId, PublicApprovalRequest } from '@quintal/shared';
import { useEffect, useState } from 'react';

import { approvalStatus, type ApprovalState } from '../approvals';

/**
 * "Bob wants to run Bash. Allow once, or deny?"
 *
 * The question used to be a sentence in the transcript, answerable only by
 * typing the right words at the right agent — and with two turns asking at
 * once, by typing them unambiguously, which the words did not allow. So it
 * is a card now, with the tool named, the action shown, and two buttons that
 * carry the request's own id.
 *
 * Only the owner gets buttons. Everybody who can read the conversation sees
 * that the agent is waiting, because an agent stopped on a question is the
 * thing that looked like a slow agent, and that is worth seeing. But one
 * person is accountable for it, and the office refuses anybody else's answer
 * anyway — so nobody else is offered a control that would only be refused.
 *
 * There is deliberately no "always". The harness offers the narrowest allow
 * the runtime actually sent whose breadth and lifetime have been established,
 * and writes the button's words from those two facts — so "Allow once" means
 * once, and a runtime whose only allow is an unmeasured "always" gets Deny
 * alone. A button that cannot explain what it grants should not exist. See
 * QUIN-53 and docs/RUNTIME-PERMISSIONS.md.
 *
 * Which is why the label is the harness's and not this component's: writing
 * "Allow once" here would put the promise back in the one place that cannot
 * check it.
 */
export function ApprovalCard({
  approval,
  approvals,
  isOwner,
  onDecide,
}: {
  approval: PublicApprovalRequest;
  approvals: ApprovalState;
  /** Whether the person reading this is the one who may answer. */
  isOwner: boolean;
  onDecide: (requestId: string, optionId: ApprovalOptionId) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const status = approvalStatus(approvals, approval, now);
  const over = status.kind === 'resolved';
  useEffect(() => {
    if (over) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [over]);

  const left = Math.max(0, approval.expiresAt - now);
  const allow = approval.options.find((option) => option.id === 'allow_once');
  const deny = approval.options.find((option) => option.id === 'deny');

  return (
    <section
      className={`my-1 min-w-0 rounded border px-2 py-1.5 ${
        over ? 'border-white/10 bg-white/[0.03]' : 'border-amber-300/40 bg-amber-300/[0.07]'
      }`}
      data-approval-id={approval.requestId}
      data-approval-state={status.kind}
      data-approval-private={approval.private ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-white/45">
        <span className={over ? 'text-white/50' : 'text-amber-200'}>
          {over ? '○' : '◆'} {approval.agentName}
        </span>
        <span>{over ? 'asked to run' : 'wants to run'}</span>
        <span className="font-semibold text-white/85">{approval.toolName}</span>
        {!over ? (
          <span className="ml-auto font-mono text-[10px] tabular-nums">
            {formatLeft(left)} left
          </span>
        ) : null}
      </div>

      {approval.summary ? (
        <pre className="mt-1 max-h-24 overflow-auto rounded bg-black/25 px-2 py-1 text-[11px] whitespace-pre-wrap break-words text-white/80">
          {approval.summary}
        </pre>
      ) : (
        <p className="mt-1 text-[11px] text-white/45">
          The runtime did not say what it would do beyond naming the tool.
        </p>
      )}

      {status.kind === 'resolved' ? (
        <p className="mt-1.5 text-xs text-white/60">{status.label}</p>
      ) : isOwner ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {allow ? (
            <button
              type="button"
              disabled={status.kind === 'sending'}
              onClick={() => onDecide(approval.requestId, 'allow_once')}
              className="rounded border border-emerald-300/40 bg-emerald-300/10 px-2 py-0.5 text-xs text-emerald-200 hover:bg-emerald-300/20 disabled:opacity-40"
            >
              {allow.label}
            </button>
          ) : null}
          {deny ? (
            <button
              type="button"
              disabled={status.kind === 'sending'}
              onClick={() => onDecide(approval.requestId, 'deny')}
              className="rounded border border-white/20 px-2 py-0.5 text-xs text-white/70 hover:bg-white/10 disabled:opacity-40"
            >
              {deny.label}
            </button>
          ) : null}
          <span className="font-mono text-[10px] text-white/35">
            {status.kind === 'sending' ? 'sending…' : 'no answer denies it'}
          </span>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-white/40">
          Waiting for {approval.ownerName}.
        </p>
      )}
    </section>
  );
}

/** "4:12", "48s". Coarse while there is time, by the second when there is not. */
function formatLeft(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
