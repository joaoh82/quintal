import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets the office keeps for somebody else — today the office's GitHub
 * token — sealed at rest, so a copied database is not a copied write key.
 *
 * AES-256-GCM under a key derived with HKDF from `BETTER_AUTH_SECRET`: the
 * one secret every deployment already has (the Docker image and the desktop
 * app make one; production refuses to start without it), and one the
 * database never holds. Each sealed value is bound to what it is for (the
 * `context`, e.g. the workspace id), so a row copied onto another office does
 * not open there.
 *
 * Format: `sealed1.<key id>.<iv>.<ciphertext + tag>`, base64url. The version
 * says how to open it; the key id says which secret sealed it, so a value
 * sealed under a secret since replaced is told apart from a damaged one, and
 * a rotation can find what needs wrapping again.
 *
 * No secret, no sealing: the callers refuse to keep the value rather than
 * keep it in plain text.
 */

const VERSION = 'sealed1';
const SECRET_ENV = 'BETTER_AUTH_SECRET';
// Separates this key from Better Auth's own use of the same secret.
const HKDF_INFO = 'quintal/sealed-secrets/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealingKey {
  key: Buffer;
  /** Names the secret without revealing it: a hash of the derived key, shortened. */
  id: string;
}

/** The key this server seals with, or null when it has no secret to derive one from. */
export function sealingKey(env: NodeJS.ProcessEnv = process.env): SealingKey | null {
  const secret = env[SECRET_ENV];
  if (!secret) return null;
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), HKDF_INFO, 32));
  return { key, id: createHash('sha256').update(key).digest('hex').slice(0, 8) };
}

/** Why a value cannot be sealed: said to whoever tried to save one. */
export const NO_SEALING_KEY = `${SECRET_ENV} is not set, so this server has nothing to encrypt the token with and will not keep it in plain text. Set ${SECRET_ENV} (openssl rand -base64 32) and restart.`;

export function isSealed(value: string): boolean {
  return value.startsWith(`${VERSION}.`);
}

export function sealSecret(plaintext: string, context: string, key: SealingKey): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return [VERSION, key.id, iv.toString('base64url'), body.toString('base64url')].join('.');
}

/**
 * Why a sealed value does not open:
 * - `no_key`: this server has no secret.
 * - `other_key`: sealed under a secret this server no longer has.
 * - `damaged`: not a sealed value, tampered with, or for another context.
 */
export type OpenFailure = 'no_key' | 'other_key' | 'damaged';

export type Opened = { ok: true; value: string } | { ok: false; reason: OpenFailure };

export function openSecret(sealed: string, context: string, key: SealingKey | null): Opened {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return { ok: false, reason: 'damaged' };
  if (!key) return { ok: false, reason: 'no_key' };
  const [, id, iv, body] = parts as [string, string, string, string];
  if (id !== key.id) return { ok: false, reason: 'other_key' };
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.length < TAG_BYTES) return { ok: false, reason: 'damaged' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const value = Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)), decipher.final()]);
    return { ok: true, value: value.toString('utf8') };
  } catch {
    return { ok: false, reason: 'damaged' };
  }
}
