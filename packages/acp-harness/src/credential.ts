import { AGENT_KEY_PREFIX, getPublicKeyHex, parseSecretKey } from '@quintal/shared';

import { ConfigError } from './config.js';

/**
 * What an agent presents at the door, decided once from its config.
 *
 * Three kinds, in the order the harness prefers them. A **keypair** is the
 * agent's own key (credentials v2): the office never minted it and cannot
 * forge it. A **host** credential is the machine's token acting as an
 * office-defined agent. A **key** is a legacy `qa_` secret. Exactly one
 * travels on a join, so the audit log can say which door was used.
 */
export type AgentCredential =
  | { kind: 'keypair'; secretKey: Uint8Array; pubkey: string }
  | { kind: 'host'; token: string; agentId: string }
  | { kind: 'key'; key: string };

export function credentialFor(config: {
  name: string;
  key: string;
  hostToken?: string;
  agentId?: string;
}): AgentCredential {
  const key = config.key.trim();
  if (key.length > 0) {
    const secretKey = parseSecretKey(key);
    if (secretKey) return { kind: 'keypair', secretKey, pubkey: getPublicKeyHex(secretKey) };
    if (key.startsWith(AGENT_KEY_PREFIX)) return { kind: 'key', key };
    // Say what it looked like, never what it was: a mistyped secret is still
    // most of a secret.
    if (key.toLowerCase().startsWith('nsec1')) {
      throw new ConfigError(`agent "${config.name}": the key looks like an nsec but does not decode`);
    }
    throw new ConfigError(
      `agent "${config.name}": the key is not an nsec, 64 hex characters, or a ${AGENT_KEY_PREFIX} key`,
    );
  }
  if (config.hostToken && config.agentId) {
    return { kind: 'host', token: config.hostToken, agentId: config.agentId };
  }
  throw new ConfigError(`agent "${config.name}": needs a key`);
}

/** The variable the desktop app fills with one key per fleet agent. */
export const AGENT_KEYS_ENV = 'QUINTAL_AGENT_KEYS';

/**
 * `QUINTAL_AGENT_KEYS`: a JSON object of agent id to secret key, from the
 * environment only — never a flag, never a file. The desktop app fills it at
 * spawn from the keychain, one entry per agent it holds a key for; an agent
 * without one falls back to the host token while legacy credentials are on.
 *
 * Errors name the variable and, at most, an agent id. Never a value.
 */
export function readAgentKeyMap(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const raw = env[AGENT_KEYS_ENV];
  const keys = new Map<string, string>();
  if (!raw || raw.trim().length === 0) return keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${AGENT_KEYS_ENV} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${AGENT_KEYS_ENV} must be a JSON object of agent id to secret key`);
  }
  for (const [agentId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || parseSecretKey(value) === null) {
      throw new ConfigError(`${AGENT_KEYS_ENV}: the key for agent ${agentId} is not an nsec or 64 hex characters`);
    }
    keys.set(agentId, value.trim());
  }
  return keys;
}
