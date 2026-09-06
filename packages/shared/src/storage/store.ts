/**
 * Somewhere to put bytes.
 *
 * Everything Quintal stores is a row in SQLite, except what cannot be: an
 * avatar, and later a screenshot dragged into a channel. This is the seam
 * those go through. It is deliberately small — put, get, delete — because
 * the two backends behind it (a directory on disk, an S3-compatible bucket)
 * agree on exactly that much, and because anything larger would be a guess
 * about attachments before attachments exist.
 *
 * What it is not: access control. An unguessable key is not authorisation.
 * The routes that serve and accept objects decide who may, and this layer
 * only stores what it is handed.
 */

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
  size: number;
}

export interface PutOptions {
  contentType: string;
}

export interface ObjectStore {
  /** `local` or `s3` — for the boot log and the production guard. */
  readonly kind: 'local' | 's3';
  /** One line for the boot log. Never includes a credential. */
  readonly describe: string;
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  /** Null when there is no such object. */
  get(key: string): Promise<StoredObject | null>;
  /** True when something was there to delete. */
  delete(key: string): Promise<boolean>;
}

/**
 * The shape of a key: lowercase path segments, no dots at the start of a
 * segment, no `..`, no empty segments. Namespaced by the first segment
 * (`avatars/…`, `uploads/<user>/…`), which is what the serving route's
 * policy reads. Enforced at every backend, because a key is interpolated
 * into a filesystem path on one and a URL on the other.
 */
const KEY_SEGMENT = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9_-]+)*$/;
export const OBJECT_KEY_MAX_LENGTH = 200;

export function isObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > OBJECT_KEY_MAX_LENGTH) return false;
  const segments = key.split('/');
  if (segments.length < 2) return false;
  return segments.every((segment) => KEY_SEGMENT.test(segment));
}

export class ObjectRejected extends Error {
  constructor(
    readonly code: 'bad_key' | 'too_large' | 'wrong_type',
    message: string,
  ) {
    super(message);
    this.name = 'ObjectRejected';
  }
}

export function assertObjectKey(key: string): void {
  if (!isObjectKey(key)) throw new ObjectRejected('bad_key', `"${key}" is not an object key`);
}

/** Largest object accepted anywhere, unless a caller says smaller. */
export const OBJECT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The limits every upload path enforces, before any bytes reach a backend.
 * Server-side and in one place, so a route cannot forget one of them.
 */
export function assertObjectAllowed(
  body: Uint8Array,
  contentType: string,
  limits: { maxBytes?: number; allowedTypes: readonly string[] },
): void {
  const max = limits.maxBytes ?? OBJECT_MAX_BYTES;
  if (body.byteLength > max) {
    throw new ObjectRejected('too_large', `${body.byteLength} bytes is over the ${max}-byte limit`);
  }
  if (!limits.allowedTypes.includes(contentType)) {
    throw new ObjectRejected('wrong_type', `${contentType} is not accepted here`);
  }
}

/**
 * Store a new object and remove the one it replaces.
 *
 * Replacing an avatar is the common case, and the old bytes would otherwise
 * sit there forever: there is no sweep, by design. Written before deleted,
 * so a failure leaves the old object in place rather than neither.
 */
export async function putReplacing(
  store: ObjectStore,
  previousKey: string | null,
  key: string,
  body: Uint8Array,
  options: PutOptions,
): Promise<void> {
  await store.put(key, body, options);
  if (previousKey !== null && previousKey !== key) await store.delete(previousKey);
}

/**
 * What an image says it is, from its first bytes.
 *
 * A route that accepts "image/png" because the request said so and serves
 * it back is a route that serves whatever it was given. The magic bytes are
 * the cheap check; re-encoding (for avatars, with `sharp`) is the thorough
 * one and lives with the route that needs it.
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** The image types an upload may be. Nothing that can carry a script. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export { AVATAR_SIZE } from '../identicon.js';
/** A 128px PNG is a few kilobytes; this is generous, not a budget to fill. */
export const AVATAR_MAX_BYTES = 64 * 1024;

/**
 * Width and height from a PNG's IHDR, which is always the first chunk and
 * always at the same offset. Null for anything that is not a PNG with one.
 */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (sniffImageType(bytes) !== 'image/png' || bytes.byteLength < 24) return null;
  // Signature (8), chunk length (4), then the chunk type must be IHDR.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
