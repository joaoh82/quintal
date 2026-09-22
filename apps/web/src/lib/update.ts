/**
 * Whether to interrupt somebody about a new version, or merely to offer it.
 *
 * The rule the whole feature turns on: **declining is an answer, not a
 * snooze.** An app that asks again next launch has not respected the "no", and
 * the reliable way to make somebody never update is to make the question
 * annoying. So a declined version is remembered and the offer moves into the
 * furniture — visible, permanent, quiet — until there is a version they have
 * not been asked about.
 *
 * Kept pure and kept here because every one of these decisions is a rule about
 * what to show a person, and rules about people are the ones worth being able
 * to read in a test.
 */

/** An update the host is offering, as it crosses the bridge. */
export interface Available {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
  /** False where this copy cannot replace itself — a .deb, a read-only mount. */
  canInstall: boolean;
  /** Why not, when it cannot. Shown in place of a button that would fail. */
  blocked: string | null;
}

export type UpdateOffer =
  /** Nothing newer, nothing to say. */
  | { kind: 'none' }
  /** Ask, once, because this version has not been declined. */
  | { kind: 'prompt'; update: Available }
  /** Already declined: stay visible, stay quiet. */
  | { kind: 'badge'; update: Available };

/**
 * Compare two versions the way SemVer orders them.
 *
 * Only as much as this needs: three numbers and an optional prerelease tag.
 * Returns negative when `a` is older, positive when newer, zero when the same.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const cleaned = version.replace(/^v/, '');
    // Split on the *first* dash only: `0.3.0-rc-1` has one prerelease tag, not
    // two, and `split('-', 2)` would quietly drop half of it.
    const dash = cleaned.indexOf('-');
    const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
    const pre = dash === -1 ? null : cleaned.slice(dash + 1);
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, pre };
  };

  const left = parse(a);
  const right = parse(b);

  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  // Same three numbers. A prerelease comes *before* the release it leads to —
  // 0.3.0-rc.1 is older than 0.3.0, not newer — which is the half of SemVer
  // that a naive string compare gets backwards.
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Does this version carry a prerelease tag — `0.3.0-rc.1` and friends? */
export function isPrerelease(version: string): boolean {
  return version.replace(/^v/, '').includes('-');
}

/**
 * What to show, given what the host said and what was declined before.
 *
 * `dismissed` is the last version this machine said no to. Anything newer than
 * that is a question nobody has answered yet, so it gets asked.
 */
export function decideOffer(
  available: Available | null,
  dismissed: string | null,
): UpdateOffer {
  if (!available) return { kind: 'none' };

  // The release rehearsal in RELEASING.md publishes `0.0.1-rc.1` tags, and
  // SemVer puts those *above* the stable release before them — so without this
  // a rehearsal would offer every stable install a release candidate. Somebody
  // already running a prerelease is a different case: they opted in, and they
  // should be offered the next one.
  if (isPrerelease(available.version) && !isPrerelease(available.current)) {
    return { kind: 'none' };
  }

  // The host only offers what is newer, but this does not take that on trust:
  // a manifest is a file on the internet, and "install this older build" is not
  // a thing the UI should ever be talked into asking for.
  if (compareVersions(available.version, available.current) <= 0) {
    return { kind: 'none' };
  }

  if (dismissed && compareVersions(available.version, dismissed) <= 0) {
    return { kind: 'badge', update: available };
  }

  return { kind: 'prompt', update: available };
}
