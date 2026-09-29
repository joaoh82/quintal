import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * A Developer ID identity has to be *in a keychain* before `codesign --sign`
 * can find it by name. Tauri imports `APPLE_CERTIFICATE` into a keychain of
 * its own, but only once `tauri build` runs — and the personal office payload
 * is signed before that, because Tauri copies it into `Resources/` already
 * signed. So between the two there is a window where the identity is a name
 * and nothing else, and codesign says exactly that:
 *
 *     ***: no identity found
 *
 * which is what took both macOS jobs down on v0.6.0. This module opens that
 * window: a throwaway keychain holding the certificate, added to the search
 * list for the duration of `run` and deleted afterwards, leaving Tauri's own
 * handling untouched.
 *
 * The default keychain is deliberately not touched. codesign searches the
 * whole list, so prepending is enough, and a job that dies mid-way then
 * cannot leave the runner pointing at a keychain that no longer exists.
 */

/** The user keychain search list, as absolute paths. */
function searchList() {
  const out = execFileSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function security(args, { quiet = true } = {}) {
  // Passwords travel in argv here. That is what `security` accepts, and the
  // runner's process list is not a boundary we are defending — the secret is
  // already in this process's environment. Output is dropped so a failure
  // message can never carry the password back into the log.
  execFileSync('security', args, { stdio: quiet ? 'ignore' : 'inherit' });
}

/**
 * Run `fn` with `certificate` (base64 DER/p12) importable by codesign.
 *
 * Returns whatever `fn` returns. The keychain and the decoded certificate are
 * removed on the way out, including when `fn` throws.
 */
export function withSigningKeychain({ certificate, password }, fn, { log = console.log } = {}) {
  if (process.platform !== 'darwin') return fn();
  if (!certificate || !password) {
    throw new Error('withSigningKeychain needs APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD');
  }

  const dir = mkdtempSync(join(tmpdir(), 'quintal-signing-'));
  const keychain = join(dir, 'payload-signing.keychain-db');
  const p12 = join(dir, 'certificate.p12');
  const keychainPassword = randomBytes(24).toString('hex');
  const previous = searchList();
  let created = false;

  try {
    writeFileSync(p12, Buffer.from(certificate, 'base64'), { mode: 0o600 });

    security(['create-keychain', '-p', keychainPassword, keychain]);
    created = true;
    // No auto-lock: a locked keychain mid-signing fails the same way a missing
    // one does, and this keychain outlives nothing.
    security(['set-keychain-settings', '-lut', '21600', keychain]);
    security(['unlock-keychain', '-p', keychainPassword, keychain]);
    security(['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign', '-f', 'pkcs12']);
    // Without this, codesign hits the interactive "allow access?" prompt that
    // no CI runner can answer, and hangs until the job times out.
    security(['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', keychainPassword, keychain]);
    security(['list-keychains', '-d', 'user', '-s', keychain, ...previous]);

    log('[signing-keychain] imported the Developer ID certificate into a temporary keychain');
    return fn();
  } finally {
    // Restore the search list first: leaving a deleted keychain in it breaks
    // every later `security` call in the job, including Tauri's.
    try {
      security(['list-keychains', '-d', 'user', '-s', ...previous]);
    } catch {
      // Nothing useful to do, and it must not mask an error from `fn`.
    }
    if (created) {
      try {
        security(['delete-keychain', keychain]);
      } catch {
        // Same.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
