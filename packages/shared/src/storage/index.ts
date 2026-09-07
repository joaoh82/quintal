/**
 * Object storage — server-only, like `@quintal/shared/db`.
 *
 * Imported as `@quintal/shared/storage`. Nothing here belongs in a browser
 * bundle: the local backend touches the filesystem and the S3 backend holds
 * a credential.
 */
export {
  AVATAR_MAX_BYTES,
  AVATAR_SIZE,
  IMAGE_TYPES,
  OBJECT_KEY_MAX_LENGTH,
  OBJECT_MAX_BYTES,
  ObjectRejected,
  assertObjectAllowed,
  assertObjectKey,
  extensionFor,
  isObjectKey,
  pngDimensions,
  putReplacing,
  sniffImageType,
  type ObjectStore,
  type PutOptions,
  type StoredObject,
} from './store.js';
export { LocalObjectStore } from './local.js';
export { S3ObjectStore, type S3Config } from './s3.js';
export {
  DEFAULT_STORAGE_URL,
  assertStorageFitForProduction,
  describeStorage,
  getStorage,
  openStorage,
  resolveStorage,
  type ResolvedStorage,
} from './config.js';
