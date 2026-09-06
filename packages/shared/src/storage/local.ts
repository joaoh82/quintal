import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { assertObjectKey, type ObjectStore, type PutOptions, type StoredObject } from './store.js';

/**
 * A directory on disk.
 *
 * The default, and a first-class backend rather than a degraded one: the
 * promise of Quintal is one process, one port, one SQLite file, and a fresh
 * clone still needs no configuration to keep an avatar. The directory sits
 * beside the database under the data root, so it is gitignored for free and
 * a backup of `data/` is a backup of everything.
 *
 * Each object is a file, with its content type in a sidecar beside it —
 * an extension is a hint and a sidecar is a fact. Writes go to a temporary
 * name and are renamed into place, so a crash mid-write leaves the previous
 * object rather than half of a new one.
 */
export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  readonly describe: string;

  constructor(readonly root: string) {
    this.describe = `local directory ${root}`;
  }

  #pathOf(key: string): string {
    assertObjectKey(key);
    const path = resolve(this.root, key);
    // Belt and braces over the key check: nothing resolves outside the root.
    if (!path.startsWith(resolve(this.root) + sep)) {
      throw new Error(`"${key}" resolves outside the object root`);
    }
    return path;
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    const path = this.#pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, body);
    await writeFile(
      `${temp}.meta`,
      JSON.stringify({ contentType: options.contentType, size: body.byteLength }),
    );
    await rename(`${temp}.meta`, metaPath(path));
    await rename(temp, path);
  }

  async get(key: string): Promise<StoredObject | null> {
    const path = this.#pathOf(key);
    try {
      const [body, meta] = await Promise.all([readFile(path), readFile(metaPath(path), 'utf8')]);
      const parsed = JSON.parse(meta) as { contentType?: string };
      return {
        body: new Uint8Array(body),
        contentType: parsed.contentType ?? 'application/octet-stream',
        size: body.byteLength,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.#pathOf(key);
    let existed = false;
    try {
      await rm(path);
      existed = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rm(metaPath(path), { force: true });
    return existed;
  }
}

function metaPath(path: string): string {
  return join(dirname(path), `.${path.slice(dirname(path).length + 1)}.meta`);
}
