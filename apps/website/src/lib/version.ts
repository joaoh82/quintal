import pkg from "../../package.json";

/**
 * The current Quintal release. `just release` sets every package's version,
 * this site's included, so the site says the new version from the release
 * commit on, with nothing to edit by hand.
 */
export const VERSION: string = pkg.version;
