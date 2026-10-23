import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad } from '@scure/base';

import { isPubkeyHex } from './identity.js';

/**
 * An agent's own MCP servers — Slack, Linear, a local tool — defined in the
 * office, on the agent's settings page, and handed to its runtime by the
 * harness on every session.
 *
 * Before this, giving an agent a tool meant a terminal on the agent's machine
 * (`claude mcp add …`), a sign-in there, and a new conversation, because the
 * runtime read its configuration once at start. Defined here, the server
 * travels with the agent to whichever machine runs it, works for any runtime
 * that speaks ACP, and a change reaches the agent without anyone touching that
 * machine.
 *
 * Two transports, the two ACP defines for every agent (`stdio`) and for the
 * ones that advertise it (`http`):
 *
 * - **http** — a hosted server by URL. Sign-in is OAuth, run by the runtime on
 *   the agent's machine; the office never sees a token.
 * - **stdio** — a command the runtime starts on the agent's machine. Starting
 *   it is running a program there, so the harness does so only for an agent
 *   whose owner granted it `run` — the same authority that lets it run
 *   anything else.
 *
 * Secret values — an API key in an environment variable, an `Authorization`
 * header — are **sealed in the browser to the agent's own public key**. The
 * office stores ciphertext it cannot open, and only the harness holding the
 * agent's secret key can. An agent without a key of its own (a legacy `qa_`
 * key) can have plain values only.
 *
 * Nothing here may import `node:*`: the browser seals, the harness opens.
 */

export const MCP_TRANSPORTS = ['http', 'stdio'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** A header or environment variable: a plain value, or one sealed to the agent. */
export interface McpVar {
  name: string;
  /** Shown and stored as written. Never a secret. */
  value?: string;
  /** `sealMcpSecret` output. Exactly one of `value` and `sealed`. */
  sealed?: string;
}

export interface AgentMcpServer {
  /** What the runtime calls it: tools appear as `mcp__<name>__…`. */
  name: string;
  transport: McpTransport;
  /** http: the server's URL. */
  url?: string;
  /** http: sent with every request. */
  headers?: McpVar[];
  /** stdio: the program, as found on the agent's PATH or by absolute path. */
  command?: string;
  /** stdio: its arguments, one per entry — never split from a string. */
  args?: string[];
  /** stdio: its environment, on top of nothing: the runtime passes only these. */
  env?: McpVar[];
}

export const MCP_SERVERS_MAX = 16;
export const MCP_VARS_MAX = 16;
export const MCP_ARGS_MAX = 32;
const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const TEXT_MAX = 2048;
const SEALED_MAX = 4096;

/** The harness's own server. An owner's server may not shadow it. */
export const RESERVED_MCP_NAMES: readonly string[] = ['quintal-tools', 'quintal'];

export type McpValidation = { ok: true; servers: AgentMcpServer[] } | { ok: false; error: string };

/**
 * Check a list as stored, from anywhere — a form, the database, the wire.
 *
 * Returns a normalised copy with nothing on it that was not checked, so a
 * crafted field cannot ride along into the runtime's configuration.
 */
export function validateMcpServers(input: unknown): McpValidation {
  if (!Array.isArray(input)) return { ok: false, error: 'MCP servers must be a list.' };
  if (input.length > MCP_SERVERS_MAX) {
    return { ok: false, error: `At most ${MCP_SERVERS_MAX} MCP servers per agent.` };
  }
  const servers: AgentMcpServer[] = [];
  const names = new Set<string>();
  for (const raw of input) {
    const checked = validateServer(raw);
    if (typeof checked === 'string') return { ok: false, error: checked };
    if (names.has(checked.name)) return { ok: false, error: `Two servers are called "${checked.name}".` };
    names.add(checked.name);
    servers.push(checked);
  }
  return { ok: true, servers };
}

function validateServer(raw: unknown): AgentMcpServer | string {
  if (!raw || typeof raw !== 'object') return 'An MCP server must be an object.';
  const server = raw as Record<string, unknown>;
  const name = typeof server.name === 'string' ? server.name.trim() : '';
  if (!MCP_NAME.test(name)) {
    return 'A server name is lowercase letters, digits, - and _, up to 32, starting with a letter or digit.';
  }
  if (RESERVED_MCP_NAMES.includes(name)) return `"${name}" is the office's own server; pick another name.`;

  if (server.transport === 'http') {
    const url = typeof server.url === 'string' ? server.url.trim() : '';
    if (!isServerUrl(url)) {
      return `"${name}": the URL must be https, or http on this machine (localhost).`;
    }
    const headers = validateVars(server.headers, `"${name}" header`);
    if (typeof headers === 'string') return headers;
    return { name, transport: 'http', url, ...(headers.length > 0 ? { headers } : {}) };
  }

  if (server.transport === 'stdio') {
    const command = typeof server.command === 'string' ? server.command.trim() : '';
    if (command.length === 0 || command.length > TEXT_MAX || /[\0\n\r]/.test(command)) {
      return `"${name}": the command is required, on one line.`;
    }
    const args = server.args ?? [];
    if (!Array.isArray(args) || args.length > MCP_ARGS_MAX) {
      return `"${name}": at most ${MCP_ARGS_MAX} arguments.`;
    }
    for (const arg of args) {
      if (typeof arg !== 'string' || arg.length > TEXT_MAX || arg.includes('\0')) {
        return `"${name}": every argument is text.`;
      }
    }
    const env = validateVars(server.env, `"${name}" variable`);
    if (typeof env === 'string') return env;
    return {
      name,
      transport: 'stdio',
      command,
      ...(args.length > 0 ? { args: [...(args as string[])] } : {}),
      ...(env.length > 0 ? { env } : {}),
    };
  }

  return `"${name}": the transport is http or stdio.`;
}

function validateVars(raw: unknown, what: string): McpVar[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MCP_VARS_MAX) return `At most ${MCP_VARS_MAX} of each ${what}.`;
  const vars: McpVar[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return `Every ${what} has a name and a value.`;
    const { name, value, sealed } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !VAR_NAME.test(name)) return `A ${what} name is letters, digits, - and _.`;
    if (seen.has(name)) return `The ${what} "${name}" is given twice.`;
    seen.add(name);
    if (typeof sealed === 'string' && value === undefined) {
      if (!isSealedMcpSecret(sealed)) return `The ${what} "${name}" is not a sealed value.`;
      vars.push({ name, sealed });
    } else if (typeof value === 'string' && sealed === undefined) {
      if (value.length > TEXT_MAX || /[\0\n\r]/.test(value)) return `The ${what} "${name}" must be one line.`;
      vars.push({ name, value });
    } else {
      return `The ${what} "${name}" needs a value.`;
    }
  }
  return vars;
}

function isServerUrl(text: string): boolean {
  if (text.length === 0 || text.length > TEXT_MAX) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * A stable fingerprint of what the runtime would be handed — so a harness can
 * tell "the owner changed the servers" from "the office said the same thing
 * again" without comparing objects field by field.
 */
export function mcpServersFingerprint(servers: readonly AgentMcpServer[]): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(servers)))).slice(0, 16);
}

// --- status, as the harness reports it -------------------------------------

export const MCP_SERVER_STATES = ['ready', 'sign_in', 'skipped'] as const;
export type McpServerState = (typeof MCP_SERVER_STATES)[number];

/**
 * One server, as the harness found it on the machine. `sign_in` carries the
 * URL the runtime wants the owner to open; it is shown on the owner's own
 * settings page and nowhere else, because whoever finishes that sign-in is
 * whose account the agent acts with.
 */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  /** Why it was skipped. */
  reason?: string;
  /** Where to sign in, while `state` is `sign_in`. */
  signInUrl?: string;
  /** ms since epoch. */
  at: number;
}

/** `agent:mcp_status`, rebuilt at the trust boundary: an agent key is a pasted credential. */
export function parseMcpStatus(input: unknown): McpServerStatus[] | null {
  const list = (input as { servers?: unknown } | null)?.servers ?? input;
  if (!Array.isArray(list) || list.length > MCP_SERVERS_MAX) return null;
  const statuses: McpServerStatus[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name : '';
    const state = entry.state as McpServerState;
    if (!MCP_NAME.test(name) || !MCP_SERVER_STATES.includes(state)) return null;
    const status: McpServerStatus = { name, state, at: Number.isFinite(entry.at) ? Number(entry.at) : Date.now() };
    if (typeof entry.reason === 'string') status.reason = entry.reason.slice(0, 300);
    // Only a web URL: this becomes a link the owner clicks.
    if (state === 'sign_in' && typeof entry.signInUrl === 'string' && isSignInUrl(entry.signInUrl)) {
      status.signInUrl = entry.signInUrl;
    }
    statuses.push(status);
  }
  return statuses;
}

function isSignInUrl(text: string): boolean {
  if (text.length > SEALED_MAX) return false;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

// --- sealing ----------------------------------------------------------------

/**
 * `qs1.` + base64url(ephemeral x-only key ‖ IV ‖ AES-256-GCM ciphertext+tag).
 *
 * ECIES over the curve agents already have keys on: an ephemeral secp256k1
 * key, ECDH with the agent's x-only key (the shared x-coordinate is the same
 * for either lift of it, so the agent's key needs no parity), HKDF-SHA256,
 * AES-GCM from WebCrypto, which browser and Node both have. The variable's
 * name is the associated data: a sealed value moved to another variable does
 * not open.
 */
const SEALED_PREFIX = 'qs1.';
const HKDF_INFO = utf8ToBytes('quintal:mcp-secret:v1');

export function isSealedMcpSecret(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith(SEALED_PREFIX) &&
    value.length <= SEALED_MAX &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(SEALED_PREFIX.length))
  );
}

async function aesKey(shared: Uint8Array, ephemeral: Uint8Array, agent: Uint8Array): Promise<CryptoKey> {
  const salt = new Uint8Array([...ephemeral, ...agent]);
  const raw = hkdf(sha256, shared, salt, HKDF_INFO, 32);
  return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seal one secret value to an agent's x-only public key. Browser-side. */
export async function sealMcpSecret(agentPubkeyHex: string, name: string, plaintext: string): Promise<string> {
  if (!isPubkeyHex(agentPubkeyHex)) throw new Error('not an agent public key');
  const agent = hexToBytes(agentPubkeyHex);
  const ephemeralSecret = secp256k1.utils.randomSecretKey();
  const ephemeral = secp256k1.getPublicKey(ephemeralSecret, true).slice(1);
  const shared = secp256k1.getSharedSecret(ephemeralSecret, new Uint8Array([2, ...agent])).slice(1);
  const key = await aesKey(shared, ephemeral, agent);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8ToBytes(name) },
      key,
      utf8ToBytes(plaintext),
    ),
  );
  return SEALED_PREFIX + base64urlnopad.encode(new Uint8Array([...ephemeral, ...iv, ...ciphertext]));
}

/** Open a sealed value with the agent's secret key. Harness-side. Throws if it is not for this key. */
export async function openMcpSecret(agentSecretKey: Uint8Array, name: string, sealed: string): Promise<string> {
  if (!isSealedMcpSecret(sealed)) throw new Error('not a sealed value');
  const bytes = base64urlnopad.decode(sealed.slice(SEALED_PREFIX.length));
  if (bytes.length < 32 + 12 + 16) throw new Error('sealed value is truncated');
  const ephemeral = bytes.slice(0, 32);
  const iv = bytes.slice(32, 44);
  const ciphertext = bytes.slice(44);
  const agent = secp256k1.getPublicKey(agentSecretKey, true).slice(1);
  const shared = secp256k1.getSharedSecret(agentSecretKey, new Uint8Array([2, ...ephemeral])).slice(1);
  const key = await aesKey(shared, ephemeral, agent);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8ToBytes(name) },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
