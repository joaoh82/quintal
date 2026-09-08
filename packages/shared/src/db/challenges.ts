import { randomBytes } from 'node:crypto';

import { and, asc, eq, lt, sql } from 'drizzle-orm';

import { agentChallengeIdentifier } from '../attestation.js';
import {
  AUTH_NONCE_BYTES,
  AUTH_NONCE_TTL_MS,
  AUTH_TIMESTAMP_SKEW_MS,
  buildAuthPayload,
  isNonceHex,
  isPubkeyHex,
  isSignatureHex,
  verifyAuthSignature,
} from '../identity.js';
import { findAgentByPubkey, type AgentCredential } from './agents.js';
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
  // Oldest by insertion, not by timestamp: two challenges issued in the same
  // millisecond share a createdAt, and "oldest" decided by a random id would
  // sometimes evict the one just handed out. SQLite's rowid is the order rows
  // arrived in, which is the only order that means anything here.
  const live = await db
    .select({ id: verifications.id })
    .from(verifications)
    .where(eq(verifications.identifier, identifier))
    .orderBy(asc(sql`rowid`));
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

// --- proving you hold the key ------------------------------------------------

/** What an agent presents: its key, and a challenge signed with the other half. */
export interface AgentChallengeProof {
  agentPubkey?: unknown;
  sig?: unknown;
  nonce?: unknown;
  timestamp?: unknown;
}

export type AgentChallengeVerdict =
  | { ok: true; credential: AgentCredential }
  | { ok: false; message: string };

/**
 * Does this proof show that a registered, unrevoked agent holds this key?
 *
 * The half of the door that every caller shares — the room, and the office
 * lookup an agent makes before it can name a room. What comes after (this
 * office, the attestation, the owner's membership) is the room's business.
 *
 * The order is the order in which the checks can be abused, cheapest first,
 * and each stops with a message that says what was wrong and nothing about
 * what would have been right. Signature before nonce: verifying is cheap and
 * consuming is destructive, and the other order would let anyone spend an
 * agent's outstanding challenge by sending garbage under its key.
 */
export async function verifyAgentChallenge(
  db: Database,
  proof: AgentChallengeProof,
  { origin, now = Date.now() }: { origin: string; now?: number },
): Promise<AgentChallengeVerdict> {
  const refuse = (message: string): AgentChallengeVerdict => ({ ok: false, message });
  const { agentPubkey, sig, nonce, timestamp } = proof;

  if (
    !isPubkeyHex(agentPubkey) ||
    !isSignatureHex(sig) ||
    !isNonceHex(nonce) ||
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp)
  ) {
    return refuse('Malformed keypair credential: expected agentPubkey, sig, nonce, timestamp.');
  }
  const pubkey = agentPubkey as string;

  if (Math.abs(now - timestamp * 1000) > AUTH_TIMESTAMP_SKEW_MS) {
    return refuse('That signature is stale. Check your clock and try again.');
  }

  const payload = buildAuthPayload({ origin, nonce: nonce as string, timestamp });
  if (!verifyAuthSignature({ pubkey, sig: sig as string, payload })) {
    return refuse('Signature does not verify against that public key for this origin.');
  }

  // Spent by key *and* value: a nonce issued for another key, or one this key
  // no longer holds, finds nothing — and spends nothing.
  if (!(await consumeAgentChallenge(db, pubkey, nonce as string, new Date(now)))) {
    return refuse('That challenge has expired, was already used, or was not issued for this key.');
  }

  const credential = await findAgentByPubkey(db, pubkey);
  if (!credential) {
    return refuse('No agent has that key, or it was revoked. Register one at /settings/agents.');
  }
  return { ok: true, credential };
}
