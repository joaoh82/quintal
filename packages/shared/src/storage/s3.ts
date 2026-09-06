import { AwsClient } from 'aws4fetch';

import { assertObjectKey, type ObjectStore, type PutOptions, type StoredObject } from './store.js';

export interface S3Config {
  bucket: string;
  /** Origin of the service, e.g. `https://s3.example.com` or a MinIO URL. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * An S3-compatible bucket.
 *
 * The seam is the S3 API, not a vendor: Railway Buckets, Cloudflare R2,
 * Backblaze, plain S3, MinIO and Garage all speak it. So nothing here names
 * one, and the client is a signer over `fetch` rather than the AWS SDK —
 * three requests, written by hand, because that is all the interface needs
 * and the SDK would be the heaviest thing in the tree by a distance.
 *
 * Path-style addressing (`endpoint/bucket/key`), which every self-hostable
 * target supports and which needs no DNS for a bucket name.
 */
export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  readonly describe: string;
  readonly #client: AwsClient;
  readonly #base: string;

  constructor(config: S3Config) {
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
    });
    this.#base = `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`;
    this.describe = `s3 bucket ${config.bucket} at ${config.endpoint}`;
  }

  #urlOf(key: string): string {
    assertObjectKey(key);
    return `${this.#base}/${key}`;
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    const response = await this.#client.fetch(this.#urlOf(key), {
      method: 'PUT',
      headers: { 'content-type': options.contentType, 'content-length': String(body.byteLength) },
      body,
    });
    if (!response.ok) throw await refused('put', key, response);
  }

  async get(key: string): Promise<StoredObject | null> {
    const response = await this.#client.fetch(this.#urlOf(key), { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw await refused('get', key, response);
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      body,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      size: body.byteLength,
    };
  }

  async delete(key: string): Promise<boolean> {
    // S3 answers 204 whether or not the object existed, so "was it there" is
    // a HEAD first. Two requests, but delete is rare and the answer matters
    // to a caller reporting what it cleaned up.
    const head = await this.#client.fetch(this.#urlOf(key), { method: 'HEAD' });
    if (head.status === 404) return false;
    const response = await this.#client.fetch(this.#urlOf(key), { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw await refused('delete', key, response);
    return true;
  }
}

async function refused(verb: string, key: string, response: Response): Promise<Error> {
  const detail = (await response.text().catch(() => '')).slice(0, 200);
  return new Error(`s3 ${verb} ${key}: ${response.status}${detail ? ` ${detail}` : ''}`);
}
