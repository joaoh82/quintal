/**
 * Which versions are in the room.
 *
 * There are two of them and they drift on purpose. The app arrives from a DMG
 * somebody downloaded once; the office is a server that may be weeks behind it,
 * and may not be theirs. Printing one number would be printing whichever one
 * happened to be handy, which is worse than printing none: "0.1.2" on a screen
 * is read as *the* version, and being wrong about that sends people looking for
 * bugs in the wrong half.
 *
 * So the rules are: agree and there is one number; disagree and both are shown,
 * labelled; and when neither is known there is nothing to say and nothing is
 * said. Never "unknown" — `WhichServer` sets the precedent that a moment of no
 * answer beats a confident wrong one.
 */

/** A number to print, and what it belongs to. `label` is null when it is both. */
export interface VersionPart {
  label: 'app' | 'server' | null;
  version: string;
}

/**
 * What to render, given what is known.
 *
 * `app` is null in a browser, which has no app to have a version. `server` is
 * null before `/health` has answered, and stays null if it never does — an
 * office too old or too broken to say is not worth an error line down here.
 */
export function versionParts(
  app: string | null,
  server: string | null,
): VersionPart[] {
  if (app && server) {
    // The common case by a wide margin: one machine, one release, kept in step
    // by `scripts/set-version.mjs`. Saying it twice would imply a distinction
    // that is not there.
    if (app === server) return [{ label: null, version: app }];
    return [
      { label: 'app', version: app },
      { label: 'server', version: server },
    ];
  }
  // Exactly one is known. It is still unlabelled: in a browser there is no app
  // for "server" to be distinguishing itself from, and on the picker screen
  // there is no server yet. A label with nothing to contrast against reads as
  // a warning about a difference nobody has been shown.
  if (app) return [{ label: null, version: app }];
  if (server) return [{ label: null, version: server }];
  return [];
}

/** The same thing as one string, for places that cannot render elements. */
export function versionLabel(app: string | null, server: string | null): string {
  return versionParts(app, server)
    .map((part) => (part.label ? `${part.label} ${part.version}` : part.version))
    .join(' · ');
}
