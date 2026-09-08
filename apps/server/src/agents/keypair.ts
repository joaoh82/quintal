import { timingSafeEqual } from 'node:crypto';

import {
  AUTH_TIMESTAMP_SKEW_MS,
  buildAuthPayload,
  isNonceHex,
  isPubkeyHex,
  isSignatureHex,
  verifyAttestation,
  verifyAuthSignature,
} from '@quintal/shared';
import {
  consumeAgentChallenge,
  findAgentByPubkey,
  findMembership,
  getDb,
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
 * standing up a room.
 *
 * The order is the order in which the checks can be abused, cheapest first:
 * a malformed credential, a stale one, a signature that isn't one, a replayed
 * nonce, a nonce for somebody else's key, a key nobody registered, an agent
 * from another office, an attestation the owner's current key did not sign,
 * and an owner who is no longer a member. Each stops with a message that says
 * what was wrong and nothing about what would have been right.
 */

export interface KeypairJoin {
  agentPubkey?: unknown;
  sig?: unknown;
  nonce?: unknown;
  timestamp?: unknown;
}

export type KeypairAuthResult =
  | { ok: true; identity: AgentIdentity; ownerPubkey: string }
  | { ok: false; message: string };

export interface KeypairAuthDeps {
  db?: Database;
  origin?: string;
  now?: number;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
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

  const { agentPubkey, sig, nonce, timestamp } = join;
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

  // Signature before nonce: verifying is cheap and consuming is destructive.
  // The other order would let anyone spend an agent's outstanding challenge
  // by sending garbage under its key.
  const payload = buildAuthPayload({ origin, nonce: nonce as string, timestamp });
  if (!verifyAuthSignature({ pubkey, sig: sig as string, payload })) {
    return refuse('Signature does not verify against that public key for this origin.');
  }

  const stored = await consumeAgentChallenge(db, pubkey, new Date(now));
  if (!stored) return refuse('That challenge has expired or was already used.');
  if (!constantTimeHexEqual(stored, nonce as string)) {
    return refuse('That challenge was not issued for this key.');
  }

  // --- the caller holds this key, from here on ---

  const credential = await findAgentByPubkey(db, pubkey);
  if (!credential) {
    return refuse('No agent has that key, or it was revoked. Register one at /settings/agents.');
  }
  if (!agentBelongsToOffice(credential.identity, workspaceId)) {
    return refuse('That agent belongs to another office.');
  }

  if (
    !verifyAttestation({
      attestation: credential.attestation,
      agentPubkey: pubkey,
      ownerPubkey: credential.ownerPubkey,
    })
  ) {
    return refuse(
      "The owner's attestation for this agent does not verify. Register its key again at /settings/agents.",
    );
  }

  // Authorisation does not erase authorship — and it does not outlive it
  // either. An owner who left the office takes their agents with them.
  const membership = await findMembership(db, credential.identity.ownerUserId, workspaceId);
  if (!membership) {
    return refuse("This agent's owner is no longer a member of this office.");
  }

  return { ok: true, identity: credential.identity, ownerPubkey: credential.ownerPubkey };
}
