import { randomBytes } from 'node:crypto';

import { and, asc, eq, lt } from 'drizzle-orm';

import { agentChallengeIdentifier } from '../attestation.js';
import { AUTH_NONCE_BYTES, AUTH_NONCE_TTL_MS } from '../identity.js';
import type { Database } from './client.js';
import { verifications } from './schema.js';

/**
 * Login nonces for agents, in the table Better Auth keeps human ones in.
 *
 * Same table, different code path: a human's challenge is issued and consumed
 * by the Better Auth plugin inside the web app, but an agent's is consumed
 * where the agent arrives — the room server, which in development is a
 * different process with no Better Auth in it. So this talks to the table
 * directly, and the two never share an identifier (see
 * `agentChallengeIdentifier`).
 */

function newId(): string {
  return randomBytes(16).toString('hex');
}

/** How many challenges one key may have outstanding at once. */
export const AGENT_CHALLENGES_PER_KEY = 5;

/**
 * Issue a nonce for this key.
 *
 * Issued to anyone who asks — a nonce is worthless without the secret, and
 * refusing unknown keys would make this an oracle for which keys are
 * registered. That openness has a cost the first version paid badly: it
 * *replaced* the outstanding nonce, so anyone who knew an agent's public key
 * (it is on its card) could spend a request to cancel a join in flight. Now
 * a nonce lives until it is used or expires, a key may hold a few at once,
 * and the oldest goes when there are too many. Expired rows for every key
 * are swept here too, so the table holds at most a minute of requests.
 */
export async function issueAgentChallenge(db: Database, pubkey: string): Promise<string> {
  const identifier = agentChallengeIdentifier(pubkey);
  const nonce = randomBytes(AUTH_NONCE_BYTES).toString('hex');
  const now = new Date();

  // Not a transaction, and not needing one: nothing here deletes a nonce
  // that could still be spent, so a consume racing with an issue either finds
  // its live row or never had one. (A libSQL `:memory:` database also opens a
  // fresh connection per transaction, which tests would notice.)
  await db.delete(verifications).where(lt(verifications.expiresAt, now));
  const live = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(eq(verifications.identifier, identifier))
    .orderBy(asc(verifications.createdAt), asc(verifications.id));
  const excess = live.length - (AGENT_CHALLENGES_PER_KEY - 1);
  for (const row of live.slice(0, Math.max(0, excess))) {
    await db.delete(verifications).where(eq(verifications.id, row.id));
  }
  await db.insert(verifications).values({
    id: newId(),
    identifier,
    value: nonce,
    expiresAt: new Date(now.getTime() + AUTH_NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Spend this nonce for this key, once.
 *
 * Matched on the value as well as the key, and deleted as it is read, in one
 * statement: two joins racing with the same signature cannot both find it,
 * and a harness that signs the wrong nonce fails without spending the right
 * one. An expired nonce is deleted too and reported as absent — the caller
 * should not be able to tell the difference, and there is nothing to keep.
 */
export async function consumeAgentChallenge(
  db: Database,
  pubkey: string,
  nonce: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .delete(verifications)
    .where(and(eq(verifications.identifier, agentChallengeIdentifier(pubkey)), eq(verifications.value, nonce)))
    .returning({ expiresAt: verifications.expiresAt });
  return rows.some((row) => row.expiresAt > now);
}
