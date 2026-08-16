import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * SHA-256 of a UTF-8 string, as hex.
 *
 * Split out so the sign-in path can load it lazily: only the NIP-07 branch
 * needs to hash a payload itself — a local key goes through `signAuthPayload`,
 * which does its own hashing.
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}
