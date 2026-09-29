/**
 * Lint every GitHub Actions workflow, the same parse CI runs.
 *
 *   node scripts/lint-workflows.mjs      (or `pnpm lint:workflows`, `just lint-workflows`)
 *
 * A workflow GitHub cannot parse does not fail — it does not run. `release.yml`
 * and `packaging.yml` sat unparseable on main for a day that way, and the bill
 * came due at a version tag: the Release run never started, v0.6.0 built no
 * installers, and that tag can never be reused. CI now parses every workflow on
 * every pull request (the `workflows` job in `ci.yml`); this is the same check,
 * runnable before you push.
 *
 * The pinned version is read out of `ci.yml` rather than repeated here, so the
 * two cannot drift apart silently. CI downloads that exact version by checksum;
 * locally we use whatever `actionlint` is on PATH and say so when it differs —
 * a warning, not a failure, because CI is the authority on green and a
 * contributor should not be blocked by a point release.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The version CI pins, read from the `workflows` job so there is one source of truth. */
function pinnedVersion() {
  const ci = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  const match = ci.match(/^\s*ACTIONLINT_VERSION:\s*(\S+)\s*$/m);
  if (!match) {
    // Not fatal: the lint is still worth running. But it means somebody
    // renamed or removed the pin, and the drift check is now blind.
    console.warn('warning: no ACTIONLINT_VERSION found in .github/workflows/ci.yml');
    return null;
  }
  return match[1];
}

/** The version of the `actionlint` on PATH, or null if there isn't one. */
function installedVersion() {
  try {
    // `actionlint --version` prints the bare version on its first line.
    return execFileSync('actionlint', ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    return null;
  }
}

const pinned = pinnedVersion();
const installed = installedVersion();

if (installed === null) {
  console.error('actionlint is not installed.\n');
  console.error('  macOS:  brew install actionlint');
  console.error('  Go:     go install github.com/rhysd/actionlint/cmd/actionlint@latest');
  console.error(`  Binary: https://github.com/rhysd/actionlint/releases${pinned ? `/tag/v${pinned}` : ''}\n`);
  console.error('CI runs this check regardless — this recipe only moves the red check earlier.');
  process.exit(127);
}

if (pinned && installed !== pinned) {
  console.warn(`warning: actionlint ${installed} locally, CI pins ${pinned}. CI is the authority.\n`);
}

// Every file, not only the changed ones: an unparseable workflow is just as
// broken when the change that breaks it touches something else entirely.
const { status } = spawnSync('actionlint', ['-color'], { cwd: root, stdio: 'inherit' });
process.exit(status ?? 1);
