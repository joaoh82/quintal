/**
 * Sign the native code inside the personal office's payload, on macOS.
 *
 *   node scripts/sign-payload.mjs [identity]
 *
 * Tauri signs the app, its frameworks and its external binaries. It does not
 * sign what is under `Resources/`, and the payload there carries Mach-O files:
 * libSQL's `.node` binding, sharp's, libvips, msgpackr's. Each arrives with
 * whatever signature its publisher gave it — usually none beyond the linker's
 * ad-hoc stamp — and that fails twice over:
 *
 * - **At runtime.** `quintal-node` is signed with the hardened runtime, so
 *   library validation applies: it may only load code signed by Apple or by
 *   the same team as itself. A `.node` file signed by somebody else, or by
 *   nobody, is refused with "mapping process and mapped file have different
 *   Team IDs", and the server dies before it has opened its database.
 *   `entitlements.plist` relaxes that with `disable-library-validation`, so a
 *   development bundle signed ad hoc still runs; a release does not need the
 *   relaxation once everything is signed by one identity, but keeps it.
 *
 * - **At notarization.** Apple scans every Mach-O in the bundle and rejects
 *   one that is not signed with a Developer ID and the hardened runtime,
 *   wherever it sits. Resources are not exempt.
 *
 * So, before `tauri build` copies the payload into the bundle, every Mach-O in
 * it is re-signed with the identity the app itself will be signed with — the
 * files are found by their magic bytes rather than their extensions, because
 * a native module is `.node` today and something else the day a dependency
 * changes its packaging. `-` signs ad hoc, for `pnpm desktop:bundle` without a
 * certificate and for release builds without Apple secrets.
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PAYLOAD_DIR = join(root, 'apps/desktop/personal-payload');

/** Mach-O magic numbers, thin and fat, either endianness. */
const MAGIC = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function isMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return MAGIC.has(head.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

/** Sign every Mach-O under `dir`. Returns the paths signed. */
export function signPayload(identity, dir = PAYLOAD_DIR, { log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    log('[sign-payload] not macOS; nothing to sign');
    return [];
  }
  const signed = [];
  for (const path of files(dir)) {
    if (!isMachO(path)) continue;
    const args = ['--force', '--sign', identity, '--options', 'runtime'];
    // A secure timestamp is what notarization wants and what an ad-hoc
    // signature cannot have.
    if (identity !== '-') args.push('--timestamp');
    execFileSync('codesign', [...args, path], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('codesign', ['--verify', '--strict', path], { stdio: 'inherit' });
    signed.push(path);
  }
  log(`[sign-payload] signed ${signed.length} Mach-O file(s) in ${dir} as ${identity === '-' ? 'ad hoc' : identity}`);
  return signed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const identity = process.argv[2] ?? process.env.APPLE_SIGNING_IDENTITY ?? '-';
  const signed = signPayload(identity);
  for (const path of signed) console.log(`  ${path.slice(PAYLOAD_DIR.length + 1)}`);
}
