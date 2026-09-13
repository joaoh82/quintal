import { execFileSync } from 'node:child_process';
import { manifests, root, setVersion, validateVersion } from './set-version.mjs';

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (process.argv.length !== 3) throw new Error('Usage: just release <semver>');
const version = validateVersion(process.argv[2]);
const tag = `v${version}`;
if (git('branch', '--show-current') !== 'main') throw new Error('Release must start on main');
if (git('status', '--porcelain')) throw new Error('Release requires a clean tree, including untracked files');
git('fetch', 'origin', '--prune', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  throw new Error('main must match origin/main; pull --ff-only before releasing');
}
if (git('tag', '--list', tag)) throw new Error(`${tag} already exists; never move a release tag`);
// Check DCO identity before changing manifests.
git('var', 'GIT_AUTHOR_IDENT');
git('var', 'GIT_COMMITTER_IDENT');
setVersion(version);
git('add', '--', ...manifests(), 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock');
git('commit', '-s', '-m', `release: ${tag}`);
git('tag', '-a', tag, '-m', `Quintal ${tag}`);
// Either both refs land, or neither does. A failed push leaves recoverable local refs.
execFileSync('git', ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`], { cwd: root, stdio: 'inherit' });
