/**
 * Withdrawing an agent's `run` scope, and what that honestly achieves.
 *
 * The scope is an ongoing authorization — the harness answers the runtime's
 * permission questions for every turn — so taking it away has to be possible
 * and has to be audited. This checks both, against a real database, and then
 * checks the part that is easy to get wrong: the words.
 *
 * Quintal creates no persistent grants, so there is no app-created grant to
 * revoke. What a runtime keeps for itself is outside Quintal and is *not*
 * revoked by this. A notice saying otherwise would be the same false promise
 * QUIN-53 took off the approval card, pointed the other way — so the wording
 * is asserted here rather than trusted.
 *
 *   DATABASE_URL=file:/tmp/... QUIN53_SEED=/path/seed.json \
 *     pnpm exec tsx apps/server/scripts/live-withdraw-run.mts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RUN_SCOPE_WITHDRAWAL_NOTE, permissionProfile } from '@quintal/shared';
import { findAgentById, getDb, listAgentEvents, setAgentScopes } from '@quintal/shared/db';

assert.ok(process.env.DATABASE_URL?.startsWith('file:/tmp/'), 'Use an isolated temporary database');
const seed = JSON.parse(readFileSync(process.env.QUIN53_SEED!, 'utf8'));
const db = getDb();

const before = await findAgentById(db, seed.agentId);
assert.ok(before, 'no such agent');
assert.ok(before.scopes.includes('run'), 'seed an agent that has `run` to withdraw it');

const after = await setAgentScopes(
  db,
  seed.agentId,
  before.scopes.filter((scope) => scope !== 'run'),
  seed.ownerId,
);
assert.ok(!after.includes('run'), 'run was not withdrawn');

// Re-read rather than trust the return: the office reads the row, not the call.
const stored = await findAgentById(db, seed.agentId);
assert.ok(stored && !stored.scopes.includes('run'), 'the stored row still has run');

const { events } = await listAgentEvents(db, seed.agentId, seed.workspaceId, { limit: 20 });
const row = events.find((event) => event.kind === 'agent.scopes_changed');
assert.ok(row, 'withdrawing a scope was not audited');
const payload = row.payload as { removed?: unknown; added?: unknown; changedByUserId?: unknown };
assert.deepEqual(payload.removed, ['run'], 'the audit row does not say what was removed');
assert.deepEqual(payload.added, [], 'the audit row invented an addition');
assert.equal(payload.changedByUserId, seed.ownerId, 'the audit row does not say who did it');

// The words. A notice that used "revoked" of anything outside Quintal, or
// promised that runtime-held rules were gone, would be the false claim.
const note = RUN_SCOPE_WITHDRAWAL_NOTE;
assert.match(note, /not revoked by this/i, 'the notice does not say what it fails to revoke');
assert.match(note, /runtime/i, 'the notice does not name where those rules live');
assert.equal(
  /\brevoked\b(?![^.]*not)/i.test(note.replace(/not revoked by this/i, '')),
  false,
  'the notice claims a revocation somewhere',
);

// And the claim has somewhere to point: a runtime that keeps its own rules
// says where, so "removed there" is actionable rather than a shrug.
const claude = permissionProfile('claude-code');
assert.ok(claude?.externalGrants?.includes('settings.json'), 'no path for externally managed grants');

console.log(
  JSON.stringify(
    {
      agent: seed.agentName,
      scopesBefore: before.scopes,
      scopesAfter: stored.scopes,
      audited: { kind: row.kind, removed: payload.removed, added: payload.added },
      notice: note,
      appCreatedPersistentGrants: 0,
      externallyManaged: Object.fromEntries(
        ['claude-code', 'codex', 'opencode']
          .map((id) => [id, permissionProfile(id)?.externalGrants ?? null]),
      ),
      pass: true,
    },
    null,
    2,
  ),
);
process.exit(0);
