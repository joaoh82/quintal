import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';

/**
 * Identity in Quintal is a keypair, not an account.
 *
 * secp256k1 with BIP-340 Schnorr signatures, and the nostr `npub`/`nsec`
 * bech32 encodings on top. Adopting those encodings is a deliberate,
 * bounded borrow: they are a well-specified way to write a public key on a
 * business card and a secret key into a password manager, and people already
 * have tooling (NIP-07 browser extensions, signers) that speaks them. It does
 * *not* make Quintal a nostr relay — we publish no events and subscribe to
 * nothing. We took the identity layer and left the network behind.
 *
 * Nothing here may import `node:*`: the browser generates and holds keys, so
 * this whole module has to run in both places unchanged.
 */

// --- wire formats -----------------------------------------------------------

/** x-only public key: 32 bytes, lowercase hex. */
const PUBKEY_HEX_LENGTH = 64;
/** BIP-340 signature: 64 bytes, lowercase hex. */
const SIGNATURE_HEX_LENGTH = 128;
/** Login nonce: 32 bytes, lowercase hex. */
export const AUTH_NONCE_BYTES = 32;
const NONCE_HEX_LENGTH = AUTH_NONCE_BYTES * 2;

const HEX = /^[0-9a-f]+$/;

/*
 * These return plain booleans rather than type predicates on purpose. As
 * `value is string` they would narrow an already-`string` argument to `never`
 * in the failing branch, which is never what a caller means by "this isn't a
 * valid key" — they still want the string, to report it or to try another
 * encoding.
 */
function isHexOfLength(value: unknown, length: number): boolean {
  return typeof value === 'string' && value.length === length && HEX.test(value);
}

/** A 32-byte x-only public key in lowercase hex — how we store and compare keys. */
export function isPubkeyHex(value: unknown): boolean {
  return isHexOfLength(value, PUBKEY_HEX_LENGTH);
}

export function isSignatureHex(value: unknown): boolean {
  return isHexOfLength(value, SIGNATURE_HEX_LENGTH);
}

export function isNonceHex(value: unknown): boolean {
  return isHexOfLength(value, NONCE_HEX_LENGTH);
}

// --- keys -------------------------------------------------------------------

/** A fresh secret key from the platform CSPRNG. 32 bytes. */
export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** The x-only public key for a secret key, lowercase hex. */
export function getPublicKeyHex(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

// --- bech32 (npub / nsec) ---------------------------------------------------

/**
 * `bech32.encode` enforces a 90-character limit by default, which is right for
 * the addresses the spec was written for. An npub/nsec is 63 characters, so the
 * default never bites — but we pass the limit explicitly on decode so a
 * malformed long string is rejected as invalid rather than throwing something
 * unrelated.
 */
const BECH32_LIMIT = 90;

function encodeBech32(prefix: 'npub' | 'nsec', bytes: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);
}

function decodeBech32(prefix: 'npub' | 'nsec', encoded: string): Uint8Array {
  const { prefix: got, words } = bech32.decode(
    encoded as `${string}1${string}`,
    BECH32_LIMIT,
  );
  if (got !== prefix) {
    throw new Error(`Expected an ${prefix}, got an ${got}`);
  }
  const bytes = bech32.fromWords(words);
  if (bytes.length !== 32) {
    throw new Error(`An ${prefix} must decode to 32 bytes, got ${bytes.length}`);
  }
  return Uint8Array.from(bytes);
}

/** Public key (hex) -> `npub1…`. */
export function npubEncode(pubkeyHex: string): string {
  if (!isPubkeyHex(pubkeyHex)) throw new Error('Not a 32-byte hex public key');
  return encodeBech32('npub', hexToBytes(pubkeyHex));
}

/** `npub1…` -> public key (hex). Throws on anything malformed. */
export function npubDecode(npub: string): string {
  return bytesToHex(decodeBech32('npub', npub.trim()));
}

/** Secret key (bytes) -> `nsec1…`. */
export function nsecEncode(secretKey: Uint8Array): string {
  if (secretKey.length !== 32) throw new Error('A secret key must be 32 bytes');
  return encodeBech32('nsec', secretKey);
}

/** `nsec1…` -> secret key (bytes). Throws on anything malformed. */
export function nsecDecode(nsec: string): Uint8Array {
  return decodeBech32('nsec', nsec.trim());
}

/** Parse either an `npub1…` or bare hex into a public key hex. Null if neither. */
export function parsePubkey(input: string): string | null {
  const trimmed = input.trim();
  if (isPubkeyHex(trimmed)) return trimmed;
  if (trimmed.toLowerCase().startsWith('npub1')) {
    try {
      return npubDecode(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

// --- display ----------------------------------------------------------------

/**
 * `npub1lf9emx9…k9frnz` — enough of both ends to recognise a key at a glance
 * and to compare two by eye, which is the only check a human can actually
 * perform on 63 characters of bech32.
 */
export function truncateNpub(npub: string): string {
  if (npub.length <= 20) return npub;
  return `${npub.slice(0, 13)}…${npub.slice(-6)}`;
}

/** What to call someone who has not named themselves yet. */
export function displayNameFromPubkey(pubkeyHex: string): string {
  return truncateNpub(npubEncode(pubkeyHex));
}

/**
 * What to call someone, given the row.
 *
 * A blank `name` means "not named yet", and the answer is derived here rather
 * than stored. That direction matters: the first version wrote the truncated
 * npub into the column at sign-up, which froze a *rendering* — ellipsis and
 * all — into data. It could not be copied, it could not be told apart from a
 * name somebody had actually chosen, and it stayed wrong forever, because the
 * fallback that would have produced a better answer never ran again.
 *
 * Derived, it costs a bech32 encode per render and is always right.
 */
export function displayName(user: {
  name?: string | null;
  pubkey: string;
}): string {
  const chosen = user.name?.trim();
  if (chosen) return chosen;
  try {
    return displayNameFromPubkey(user.pubkey);
  } catch {
    // A row with an unencodable key should still render as somebody rather
    // than take the page down with it.
    return 'Someone';
  }
}

// --- the login challenge ----------------------------------------------------

/**
 * The canonical string a client signs to prove it holds a key:
 *
 *     quintal-auth:v1:<origin>:<nonce>:<unix_ts>
 *
 * Every field is load-bearing. The version prefix lets us change the shape
 * later without a signature made for the old shape validating against the new
 * one. The origin binds the signature to *this* deployment, so a signature
 * phished by another site — or by a Quintal instance you don't trust — cannot
 * be replayed here. The nonce is server-issued and single-use. The timestamp
 * bounds how long a stolen-but-unspent signature is worth anything.
 *
 * A signer that shows the user what it is signing (a NIP-07 extension) shows
 * them this, which is why it is a readable string rather than a packed blob.
 */
export const AUTH_PAYLOAD_PREFIX = 'quintal-auth:v1';

/** How long an issued nonce stays valid. */
export const AUTH_NONCE_TTL_MS = 60_000;

/** How far from now the client's timestamp may be, in either direction. */
export const AUTH_TIMESTAMP_SKEW_MS = 60_000;

export interface AuthPayloadFields {
  /** Origin of the deployment, e.g. `https://office.example.com`. No trailing slash. */
  origin: string;
  /** The server-issued nonce, 32 bytes of hex. */
  nonce: string;
  /** Client's clock, unix seconds. */
  timestamp: number;
}

export function buildAuthPayload({
  origin,
  nonce,
  timestamp,
}: AuthPayloadFields): string {
  return `${AUTH_PAYLOAD_PREFIX}:${origin}:${nonce}:${timestamp}`;
}

/**
 * Pull the fields back out of a payload.
 *
 * Matched from the right rather than split on `:`, because the origin contains
 * one: `http://localhost:3000` would otherwise parse as an origin of
 * `http` with a nonce of `//localhost`.
 */
const PAYLOAD_PATTERN = new RegExp(
  `^${AUTH_PAYLOAD_PREFIX}:(.+):([0-9a-f]{${NONCE_HEX_LENGTH}}):(\\d{1,15})$`,
);

export function parseAuthPayload(payload: unknown): AuthPayloadFields | null {
  if (typeof payload !== 'string') return null;
  const match = PAYLOAD_PATTERN.exec(payload);
  if (!match) return null;

  const [, origin, nonce, seconds] = match;
  if (!origin || !nonce || !seconds) return null;

  const timestamp = Number(seconds);
  if (!Number.isSafeInteger(timestamp)) return null;

  return { origin, nonce, timestamp };
}

// --- signing ----------------------------------------------------------------

/** What actually gets signed: sha256 of the UTF-8 payload. */
function payloadDigest(payload: string): Uint8Array {
  return sha256(new TextEncoder().encode(payload));
}

/** Sign a canonical payload with a raw secret key. Returns lowercase hex. */
export function signAuthPayload(
  secretKey: Uint8Array,
  payload: string,
): string {
  return bytesToHex(schnorr.sign(payloadDigest(payload), secretKey));
}

/**
 * Does `sig` prove that the holder of `pubkey` signed `payload`?
 *
 * Never throws: malformed input is a failed verification, not an exception,
 * because every caller is handling untrusted bytes off the wire.
 */
export function verifyAuthSignature({
  pubkey,
  sig,
  payload,
}: {
  pubkey: string;
  sig: string;
  payload: string;
}): boolean {
  if (!isPubkeyHex(pubkey) || !isSignatureHex(sig)) return false;
  try {
    return schnorr.verify(
      hexToBytes(sig),
      payloadDigest(payload),
      hexToBytes(pubkey),
    );
  } catch {
    return false;
  }
}
