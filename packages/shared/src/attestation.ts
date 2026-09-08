import {
  isPubkeyHex,
  isSignatureHex,
  signAuthPayload,
  verifyAuthSignature,
} from './identity.js';

/**
 * Owner attestation: the signature that binds an agent's key to a person.
 *
 * An agent that proves it holds a key has proved only that — a key. What makes
 * it *somebody's* agent is a statement by that somebody, signed with the key
 * they sign in with: "the holder of this public key acts for me". The office
 * checks both signatures at the door, and the second is what lets everything
 * the agent does be attributed to its owner without the office ever having
 * minted, stored or been able to forge a credential for it.
 *
 * The preimage is a readable string rather than a packed blob for the same
 * reason the login challenge is: a signer that shows people what they are
 * signing shows them this.
 *
 *     quintal:agent-auth:<agentPubkeyHex>:<conditions>
 *
 * `conditions` is empty today. Its grammar — clauses joined by `&`, each
 * `name=value` — is validated now so that constraints (an expiry, a scope, a
 * workspace) can be added later without changing the signing ceremony. It is
 * signed *as given*, never normalised: two strings that mean the same thing
 * but differ by a byte are two different attestations, and the verifier must
 * not be the one deciding they are equivalent.
 *
 * Nothing here may import `node:*`: the browser produces attestations.
 */

export const ATTESTATION_PREFIX = 'quintal:agent-auth';

/** Room for a handful of clauses; nobody needs a paragraph of conditions. */
export const ATTESTATION_CONDITIONS_MAX_LENGTH = 512;

const CLAUSE = /^[a-z][a-z0-9_]*=[A-Za-z0-9._:/@-]*$/;

/** Is this a conditions string we would sign or accept? Empty is the usual answer. */
export function isValidConditions(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return true;
  if (value.length > ATTESTATION_CONDITIONS_MAX_LENGTH) return false;
  return value.split('&').every((clause) => CLAUSE.test(clause));
}

/**
 * The wire and storage shape: a three-element array, so it can live in a JSON
 * column, an environment variable or a config file without a schema of its
 * own. Positional on purpose — there is nothing to misspell.
 */
export type AttestationTag = [ownerPubkeyHex: string, conditions: string, sigHex: string];

export interface Attestation {
  ownerPubkey: string;
  conditions: string;
  sig: string;
}

export function buildAttestationPreimage(agentPubkey: string, conditions = ''): string {
  if (!isPubkeyHex(agentPubkey)) throw new Error('Not a 32-byte hex public key');
  if (!isValidConditions(conditions)) throw new Error('Not a valid conditions string');
  return `${ATTESTATION_PREFIX}:${agentPubkey}:${conditions}`;
}

/**
 * Sign an attestation with a raw owner secret key.
 *
 * For signers that never expose the secret — the desktop keychain, a NIP-07
 * extension — sign `buildAttestationPreimage(...)` with whatever signs the
 * login challenge and assemble the tag with `attestationTag`.
 */
export function signAttestation({
  agentPubkey,
  ownerPubkey,
  ownerSecretKey,
  conditions = '',
}: {
  agentPubkey: string;
  ownerPubkey: string;
  ownerSecretKey: Uint8Array;
  conditions?: string;
}): AttestationTag {
  if (agentPubkey === ownerPubkey) throw new Error('An agent cannot attest for itself');
  const sig = signAuthPayload(ownerSecretKey, buildAttestationPreimage(agentPubkey, conditions));
  return attestationTag({ ownerPubkey, conditions, sig });
}

export function attestationTag({ ownerPubkey, conditions, sig }: Attestation): AttestationTag {
  return [ownerPubkey, conditions, sig];
}

/**
 * Read a tag off the wire or out of the database. Strict: three strings, a
 * real public key, a real signature, a conditions string we recognise. Null
 * for anything else — malformed input is not an attestation, not an error.
 */
export function parseAttestation(value: unknown): Attestation | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [ownerPubkey, conditions, sig] = value as unknown[];
  if (!isPubkeyHex(ownerPubkey) || !isSignatureHex(sig) || !isValidConditions(conditions)) {
    return null;
  }
  return {
    ownerPubkey: ownerPubkey as string,
    conditions: conditions as string,
    sig: sig as string,
  };
}

/**
 * Does this attestation say that `ownerPubkey` vouches for `agentPubkey`?
 *
 * `ownerPubkey` is the key the *verifier* believes the owner holds — looked up
 * from the owner's row, never read out of the tag. A tag carries its owner key
 * so a reader knows who signed it; the check is that this matches who the
 * office says the owner is. Otherwise anyone could attest for anyone.
 *
 * Never throws.
 */
export function verifyAttestation({
  attestation,
  agentPubkey,
  ownerPubkey,
}: {
  attestation: unknown;
  agentPubkey: string;
  ownerPubkey: string;
}): boolean {
  const parsed = parseAttestation(attestation);
  if (!parsed) return false;
  if (!isPubkeyHex(agentPubkey) || !isPubkeyHex(ownerPubkey)) return false;
  if (parsed.ownerPubkey !== ownerPubkey) return false;
  if (agentPubkey === ownerPubkey) return false;
  let payload: string;
  try {
    payload = buildAttestationPreimage(agentPubkey, parsed.conditions);
  } catch {
    return false;
  }
  return verifyAuthSignature({ pubkey: ownerPubkey, sig: parsed.sig, payload });
}

// --- the challenge an agent signs -------------------------------------------

/**
 * Where an agent's login nonce is filed, in the same table as a human's.
 *
 * Prefixed so an agent asking for a challenge can never replace or consume the
 * nonce a human with the same key is mid-way through using — and so the two
 * cannot be confused for each other by a reader of the table.
 */
export function agentChallengeIdentifier(pubkey: string): string {
  return `agent:${pubkey}`;
}

/** How an agent tells the office which credential it is presenting. */
export type AgentCredentialKind = 'key' | 'host' | 'v2';
