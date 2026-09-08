import { HOST_TOKEN_PREFIX, npubEncode } from '@quintal/shared';
import {
  CredentialError,
  canAdministerAgent,
  findAgentOwnership,
  findHostByToken,
  hostMayActAs,
  setAgentCredential,
  type Database,
} from '@quintal/shared/db';

/**
 * Registering an agent's keypair — the one write in credentials v2.
 *
 * Two callers, one rule. A signed-in person may register a key for an agent
 * they administer; a machine may, with its host token, for an agent it may act
 * as. Neither is the *authority*: that is the owner's signature inside the
 * attestation, which `setAgentCredential` checks against the owner's current
 * key. The caller check here says who is allowed to hand the office a
 * credential; the signature says the owner agreed to it. A host token that
 * could register a key on its own would be a host token that could make
 * itself an agent's owner.
 *
 * Pure with respect to HTTP so it can be tested against a real database
 * without a request in hand; the route is a thin wrapper.
 */

export type CredentialCaller =
  | { via: 'session'; userId: string; isGuest: boolean }
  | { via: 'host'; token: string };

export interface CredentialOutcome {
  status: number;
  body: { pubkey: string; npub: string } | { error: string };
}

export function isHostTokenHeader(authorization: string | null): string | null {
  const header = authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token.startsWith(HOST_TOKEN_PREFIX) ? token : null;
}

export async function registerAgentCredential(
  db: Database,
  agentId: string,
  body: unknown,
  caller: CredentialCaller,
): Promise<CredentialOutcome> {
  const fields =
    body && typeof body === 'object'
      ? (body as { agentPubkey?: unknown; attestation?: unknown })
      : {};
  if (typeof fields.agentPubkey !== 'string' || fields.attestation === undefined) {
    return { status: 400, body: { error: 'Expected { agentPubkey, attestation }.' } };
  }

  const agent = await findAgentOwnership(db, agentId);
  if (!agent) return { status: 404, body: { error: 'No such agent.' } };

  if (caller.via === 'session') {
    if (caller.isGuest) {
      return { status: 403, body: { error: 'Guests cannot manage agents.' } };
    }
    if (!(await canAdministerAgent(db, caller.userId, agent))) {
      return { status: 403, body: { error: 'That is not your agent.' } };
    }
  } else {
    const host = await findHostByToken(db, caller.token);
    if (!host) return { status: 401, body: { error: 'Unknown or revoked host token.' } };
    if (!hostMayActAs(host, agent)) {
      return { status: 403, body: { error: 'That machine may not act as this agent.' } };
    }
  }

  try {
    const { pubkey } = await setAgentCredential(
      db,
      agentId,
      { pubkey: fields.agentPubkey, attestation: fields.attestation },
      caller.via === 'session'
        ? { via: 'session', userId: caller.userId }
        : { via: 'host', hostId: (await findHostByToken(db, caller.token))?.id ?? '' },
    );
    return { status: 200, body: { pubkey, npub: npubEncode(pubkey) } };
  } catch (error) {
    if (error instanceof CredentialError) {
      return { status: 422, body: { error: error.message } };
    }
    throw error;
  }
}
