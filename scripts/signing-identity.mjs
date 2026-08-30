/**
 * Which certificate to sign the desktop app with.
 *
 * Shared by `sign-desktop.mjs` and `bundle-desktop.mjs` so there is one answer
 * to "which identity", and one place that refuses to guess.
 *
 * The choice has to stay *stable*. A keychain grant is bound to the signing
 * certificate through the designated requirement, so signing with a different
 * one is a different program as far as macOS is concerned — and everything you
 * clicked "Always Allow" for gets asked again.
 */
import { execFileSync } from 'node:child_process';

export function codesigningIdentities() {
  const listed = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  return [...listed.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The identity to use, or a reason there isn't one.
 *
 * Never picks between several. Two certificates are two different apps to the
 * keychain, so choosing one for somebody would silently invalidate the grants
 * they already gave — better to ask once than to re-prompt forever.
 */
export function resolveIdentity() {
  const fromEnv = process.env.QUINTAL_SIGNING_IDENTITY ?? process.env.APPLE_SIGNING_IDENTITY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return { identity: fromEnv.trim() };
  }

  const names = codesigningIdentities();
  if (names.length === 1) return { identity: names[0] };

  if (names.length === 0) {
    return {
      problem:
        'No codesigning identity found.\n' +
        'Xcode creates an "Apple Development" certificate when you sign in with an Apple ID.\n' +
        '\nWithout one, nothing is broken: `pnpm desktop` still works, and macOS\n' +
        'simply asks for your keychain password on each launch. See docs/DESKTOP.md.',
    };
  }

  return {
    problem:
      `Found ${names.length} codesigning identities, and picking one for you would be\n` +
      'the wrong kind of helpful: a keychain grant is bound to the certificate, so\n' +
      'switching between them makes macOS ask for your password all over again.\n' +
      '\nChoose one and keep using it:\n' +
      names.map((name) => `  export QUINTAL_SIGNING_IDENTITY="${name}"`).join('\n') +
      '\n\nPut it in your shell profile so every build agrees.',
  };
}
