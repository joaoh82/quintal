import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

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

/**
 * Issue a nonce for this key. Replaces any outstanding one, so asking twice
 * leaves one live challenge rather than two. Issued to anyone who asks — a
 * nonce is worthless without the secret, and refusing unknown keys would make
 * this an oracle for which keys are registered.
 */
export async function issueAgentChallenge(db: Database, pubkey: string): Promise<string> {
  const identifier = agentChallengeIdentifier(pubkey);
  const nonce = randomBytes(AUTH_NONCE_BYTES).toString('hex');
  await db.delete(verifications).where(eq(verifications.identifier, identifier));
  await db.insert(verifications).values({
    id: newId(),
    identifier,
    value: nonce,
    expiresAt: new Date(Date.now() + AUTH_NONCE_TTL_MS),
  });
  return nonce;
}

/**
 * Take the outstanding nonce for this key, once.
 *
 * One statement: the row is deleted as it is read, so two joins racing with
 * the same signature cannot both find it. An expired nonce is deleted too and
 * reported as absent — the caller should not be able to tell the difference,
 * and there is nothing to keep.
 */
export async function consumeAgentChallenge(
  db: Database,
  pubkey: string,
  now: Date = new Date(),
): Promise<string | null> {
  const identifier = agentChallengeIdentifier(pubkey);
  const rows = await db
    .delete(verifications)
    .where(eq(verifications.identifier, identifier))
    .returning({ value: verifications.value, expiresAt: verifications.expiresAt });
  const live = rows.find((row) => row.expiresAt > now);
  return live?.value ?? null;
}

