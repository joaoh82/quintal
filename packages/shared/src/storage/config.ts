import { isAbsolute, resolve } from 'node:path';

import { WORKSPACE_ROOT } from '../db/url.js';
import { LocalObjectStore } from './local.js';
import { S3ObjectStore, type S3Config } from './s3.js';
import type { ObjectStore } from './store.js';

/** Where objects go when nobody said otherwise: beside the database. */
export const DEFAULT_STORAGE_URL = 'file:./data/objects';

export type ResolvedStorage =
  | { kind: 'local'; root: string }
  | { kind: 's3'; config: S3Config };

type Env = Record<string, string | undefined>;

/**
 * Resolve `STORAGE_URL` into a backend, the way `DATABASE_URL` is resolved.
 *
 * One variable. Unset, or `file:…`, is a directory under the data root.
 * `s3://bucket` is an S3-compatible bucket, with the endpoint and the
 * credentials in the variables every S3 client already reads. No code
 * changes between a laptop and a deployment.
 */
export function resolveStorage(
  env: Env = process.env,
  baseDir: string = env.QUINTAL_DATA_ROOT ?? WORKSPACE_ROOT,
): ResolvedStorage {
  const raw = (env.STORAGE_URL ?? DEFAULT_STORAGE_URL).trim();

  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length);
    return { kind: 'local', root: isAbsolute(path) ? path : resolve(baseDir, path) };
  }

  if (raw.startsWith('s3://')) {
    const bucket = raw.slice('s3://'.length).replace(/\/+$/, '');
    if (bucket.length === 0 || bucket.includes('/')) {
      throw new Error(`STORAGE_URL=${raw}: expected s3://<bucket>`);
    }
    const endpoint = env.S3_ENDPOINT?.trim();
    const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
    const missing = [
      !endpoint && 'S3_ENDPOINT',
      !accessKeyId && 'S3_ACCESS_KEY_ID',
      !secretAccessKey && 'S3_SECRET_ACCESS_KEY',
    ].filter((name): name is string => typeof name === 'string');
    if (missing.length > 0 || !endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error(`STORAGE_URL=${raw} needs ${missing.join(', ')} as well`);
    }
    return {
      kind: 's3',
      config: {
        bucket,
        endpoint,
        accessKeyId,
        secretAccessKey,
        region: env.S3_REGION?.trim() || 'auto',
      },
    };
  }

  throw new Error(`STORAGE_URL=${raw}: expected file:<dir> or s3://<bucket>`);
}

/**
 * Refuse to boot in production on a disk that will not be there tomorrow.
 *
 * The local backend *appears* to work on a container platform and then
 * loses every object on redeploy, because the filesystem is ephemeral. No
 * error, just missing avatars later — the worst failure there is. So a
 * production process with no bucket configured stops here, the way a
 * missing `BETTER_AUTH_SECRET` already does. Somebody genuinely
 * self-hosting on a box with real disk says so once, with
 * `STORAGE_ALLOW_LOCAL=1`.
 */
export function assertStorageFitForProduction(
  storage: ResolvedStorage,
  env: Env = process.env,
): void {
  if (storage.kind !== 'local') return;
  if (env.NODE_ENV !== 'production') return;
  // `next build` runs as production and serves nothing.
  if (env.NEXT_PHASE === 'phase-production-build') return;
  if (env.STORAGE_ALLOW_LOCAL === '1') return;
  throw new Error(
    'Object storage is a local directory and NODE_ENV is production. On a container ' +
      'platform that directory does not survive a redeploy, and every avatar goes with it. ' +
      'Set STORAGE_URL=s3://<bucket> with S3_ENDPOINT, S3_ACCESS_KEY_ID and ' +
      'S3_SECRET_ACCESS_KEY — or, on a machine with real disk, STORAGE_ALLOW_LOCAL=1.',
  );
}

export function describeStorage(storage: ResolvedStorage): string {
  return storage.kind === 'local'
    ? `local directory ${storage.root}`
    : `s3 bucket ${storage.config.bucket} at ${storage.config.endpoint}`;
}

export function openStorage(storage: ResolvedStorage): ObjectStore {
  return storage.kind === 'local'
    ? new LocalObjectStore(storage.root)
    : new S3ObjectStore(storage.config);
}

let shared: ObjectStore | null = null;

/** The process's one store, opened from the environment on first use. */
export function getStorage(): ObjectStore {
  if (shared === null) shared = openStorage(resolveStorage());
  return shared;
}
