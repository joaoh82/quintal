import { verifyAttestation } from '@quintal/shared';
import {
  findMembership,
  getDb,
  verifyAgentChallenge,
  type AgentChallengeProof,
  type AgentIdentity,
  type Database,
} from '@quintal/shared/db';

import { agentBelongsToOffice } from '../auth/office.js';
import { config } from '../config.js';

/**
 * Credentials v2: an agent proves it holds a key, and its owner's attestation
 * proves the key is theirs.
 *
 * Kept out of the room for the same reason `mayEnterOffice` is: this is a
 * chain of checks with an order and a message for each, and a chain that only
 * exists inside a Colyseus lifecycle method is one nothing can test without
 * standing up a room. The first half — does a registered agent hold this key —
 * is `verifyAgentChallenge` in shared, because the office lookup an agent
 * makes *before* it can name a room asks exactly that question too.
 *
 * The order is the order in which the checks can be abused, cheapest first:
 * a malformed credential, a stale one, a signature that isn't one, a replayed
 * nonce (or one issued for somebody else's key), a key nobody registered, an agent
 * from another office, an attestation the owner's current key did not sign,
 * and an owner who is no longer a member. Each stops with a message that says
 * what was wrong and nothing about what would have been right.
 */

export type KeypairJoin = AgentChallengeProof;

export type KeypairAuthResult =
  | { ok: true; identity: AgentIdentity; ownerPubkey: string }
  | { ok: false; message: string };

export interface KeypairAuthDeps {
  db?: Database;
  origin?: string;
  now?: number;
}

export async function authenticateAgentKeypair(
  join: KeypairJoin,
  workspaceId: string,
  deps: KeypairAuthDeps = {},
): Promise<KeypairAuthResult> {
  const db = deps.db ?? getDb();
  const origin = deps.origin ?? config.origin;
  const now = deps.now ?? Date.now();
  const refuse = (message: string): KeypairAuthResult => ({ ok: false, message });

  const proof = await verifyAgentChallenge(db, join, { origin, now });
  if (!proof.ok) return refuse(proof.message);
  const { credential } = proof;

  // --- the caller holds this key, from here on ---

  if (!agentBelongsToOffice(credential.identity, workspaceId)) {
    return refuse('That agent belongs to another office.');
  }

  if (
    !verifyAttestation({
      attestation: credential.attestation,
      agentPubkey: credential.pubkey,
      ownerPubkey: credential.ownerPubkey,
    })
  ) {
    return refuse(
      "The owner's attestation for this agent does not verify. Register its key again at /settings/agents.",
    );
  }

  // Authorisation does not erase authorship — and it does not outlive it
  // either. An owner who left the office takes their agents with them.
  const membership = await findMembership(db, {
    userId: credential.identity.ownerUserId,
    workspaceId,
  });
  if (!membership) {
    return refuse("This agent's owner is no longer a member of this office.");
  }

  return { ok: true, identity: credential.identity, ownerPubkey: credential.ownerPubkey };
}
