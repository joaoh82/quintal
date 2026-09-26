/**
 * What the `run` scope actually tells a live runtime.
 *
 * QUIN-53's automatic-approval half, measured rather than asserted. The agent
 * has `run`, so nobody is asked; the question is which of the runtime's own
 * options the harness takes on the owner's behalf, and whether that option
 * leaves anything behind.
 *
 * So it asks the agent to do something its runtime gates, twice with a
 * *different* action the second time, and reads the harness's own audit log.
 * A per-call allow must appear once per request. A standing grant would show
 * as a second action that was never asked about — the old behaviour, where
 * "Always allow" covered the whole tool category for the session.
 *
 *   QUIN53_SEED=/path/seed.json QUIN53_LOGS=/path/logs \
 *     pnpm exec tsx apps/server/scripts/live-run-scope-probe.mts
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client, type Room } from 'colyseus.js';
import {
  ClientMessage,
  ServerMessage,
  type ChannelChatPayload,
  type PublicApprovalRequest,
} from '@quintal/shared';

const seed = JSON.parse(readFileSync(process.env.QUIN53_SEED!, 'utf8'));
const base = process.env.QUIN53_URL ?? 'http://127.0.0.1:3057';
const logDir = process.env.QUIN53_LOGS!;
/** Each action is distinct, so a second request cannot be the first retried. */
const actions: string[] = JSON.parse(
  process.env.QUIN53_ACTIONS ?? '["one.txt","two.txt"]',
) as string[];

/** Every `permission` row the harness has written so far. */
interface PermissionRow {
  kind: string;
  tool?: string;
  actor?: string;
  decision?: string;
  runtimeOption?: string;
  runtimeOptionKind?: string | null;
  breadth?: string;
  lifetime?: string;
  persistsAt?: string | null;
  refused?: string;
  summary?: string;
}
function rows(): PermissionRow[] {
  // Every log in the directory, not one named for the office's agent: a
  // harness booted with `--agent <runtime>` names its file for the local
  // agent, and guessing the name is how this probe first proved nothing.
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(logDir, name), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as PermissionRow),
    )
    .filter((row) => row.kind === 'permission');
}

const room: Room = await new Client(`${base}/colyseus`).joinOrCreate('office', {
  mapId: 'hq',
  workspaceId: seed.workspaceId,
  token: seed.token,
});
room.onMessage('*', () => {});
const replies: string[] = [];
room.onMessage(ServerMessage.ChannelChat, (message: ChannelChatPayload) => {
  if (message.fromKind === 'agent') replies.push(message.text);
});
/**
 * Cards, so this probe covers withdrawal as well as the grant.
 *
 * With `run` the harness answers and no card exists. Take the scope away and
 * the *same* agent on the *same* runtime must start asking instead — which is
 * the only thing that makes withdrawing it meaningful, and so is the thing
 * worth watching for rather than assuming.
 */
const cards: PublicApprovalRequest[] = [];
room.onMessage(ServerMessage.Approval, (card: PublicApprovalRequest) => {
  cards.push(card);
  // Answer at once: an unanswered card holds the runtime for five minutes,
  // and `deny` is the answer that cannot leave anything behind.
  room.send(ClientMessage.ApprovalDecide, { requestId: card.requestId, optionId: 'deny' });
});

async function until(predicate: () => boolean, what: string, ms = 180_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const report: Array<Record<string, unknown>> = [];
for (const [index, file] of actions.entries()) {
  const before = rows().length;
  room.send(ClientMessage.ChannelChat, {
    channelId: seed.channelId,
    text: `@${seed.agentName} run the shell command \`touch ${file}\` in your working directory, using your shell tool. Then say done.`,
  });
  // A runtime that asks writes a row; one that was given a standing grant
  // writes nothing, which is exactly what has to be distinguishable.
  const cardsBefore = cards.length;
  await until(
    () => rows().length > before || cards.length > cardsBefore || replies.length > index,
    `action ${index + 1}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const fresh = rows().slice(before);
  report.push({
    action: file,
    asked: fresh.length,
    askedOwner: cards.length > cardsBefore,
    cardOptions: cards.slice(cardsBefore).map((card) => card.options),
    rows: fresh,
  });
}

await room.leave();
const all = rows();
console.log(
  JSON.stringify(
    {
      agent: seed.agentName,
      scopes: seed.scopes,
      actions: report,
      // The acceptance question in one line: every action was asked about, and
      // every answer authorised exactly that action.
      askedAboutEveryAction: report.every((entry) => (entry.asked as number) >= 1),
      everyAnswerPerCall: all.every(
        (row) => row.breadth === 'this_call' && row.lifetime === 'this_call',
      ),
      optionsTaken: [...new Set(all.map((row) => `${row.runtimeOption}:${row.runtimeOptionKind}`))],
      actors: [...new Set(all.map((row) => row.actor))],
      // With `run` this must be empty; without it, one per action.
      cardsSeen: cards.length,
      replies,
    },
    null,
    2,
  ),
);
assert.ok(all.length > 0, 'the runtime never asked; this probe proves nothing');
process.exit(0);
