import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReleaseVersion } from './check-release-version.mjs';
import { collect, updaterNames } from './release-assets.mjs';
import { latestJson, setReleaseDir, shouldPublish } from './latest-json.mjs';

const tag = process.argv[2];
const version = checkReleaseVersion(tag);
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const git = (...args) => run('git', args);
const gh = (...args) => run('gh', args);
const sha = git('rev-parse', `${tag}^{commit}`);
if (sha !== git('rev-parse', 'HEAD')) throw new Error('Tag moved since setup; refusing publication');
const filenames = collect('staged', 'release');
const tags = git('tag', '--sort=-version:refname', '--list', 'v[0-9]*').split('\n');
// Include commits since the nearest earlier release tag in this tag's history.
let previous;
try { previous = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`); } catch { /* first release */ }
const changes = git('log', '--format=- %s (%h)', previous ? `${previous}..${tag}` : tag);
const signing = ['macos-arm64', 'macos-x64'].map((platform) =>
  `${platform}: ${readFileSync(join('staged', platform, 'signing.txt'), 'utf8').trim()}`,
).join('\n');
const notes = `Quintal ${tag}\n\n${changes}\n\n## Installation\n\n${signing}\n\nWindows and Linux installers are unsigned. Linux AppImage requires host libdbus (libdbus-1-3 on Debian/Ubuntu), and a Secret Service provider such as GNOME Keyring for key storage; libdbus is not bundled.\n\nFor an unsigned macOS download, copy Quintal.app to Applications, then run \`xattr -dr com.apple.quarantine /Applications/Quintal.app\`. Unsigned here means no Developer ID signature or notarization; an ad-hoc signature may be present.\n\nSHA256SUMS.txt covers both versioned and stable-named downloads. The app opens a server picker; connect it to your Quintal server.\n`;
writeFileSync('release-notes.md', notes);
// Query through the API so auth/network failures cannot masquerade as "no release".
const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100`)).flat();
const existing = releases.find((release) => release.tag_name === tag);
if (existing && !existing.draft) throw new Error(`${tag} is already public; never replace published installers`);
if (!existing) gh('release', 'create', tag, '--verify-tag', '--target', sha, '--draft', '--title', `Quintal ${tag}`, '--notes-file', 'release-notes.md');
else {
  gh('release', 'edit', tag, '--notes-file', 'release-notes.md');
  // A previous partial upload may contain stale files; only drafts are mutable.
  for (const asset of existing.assets) gh('release', 'delete-asset', tag, asset.name, '--yes');
}
const prerelease = version.split('+')[0].includes('-');
// Re-running an old tag must not move /latest backwards.
const latestPublished = tags.find((item) => releases.some((release) =>
  release.tag_name === item && !release.draft && !release.prerelease,
));
const newerPublished = latestPublished && tags.indexOf(latestPublished) < tags.indexOf(tag);
const becomingLatest = !prerelease && !newerPublished;

// The update manifest, and only where it belongs. Installed copies read it
// through `releases/latest/download/latest.json`, so a prerelease or a re-run
// of an older tag must not write one — that would hand every machine that asks
// a release candidate, or walk them backwards.
// Every platform's payload and signature, or no manifest at all. A manifest
// missing one platform silently stops updating it while every other platform
// keeps working, which is the kind of failure nobody notices for a release or
// two.
const updaterComplete = updaterNames().every((name) => filenames.includes(name));
if (!updaterComplete) console.log('No latest.json: some update payloads or signatures are missing');
if (updaterComplete && shouldPublish(version, becomingLatest)) {
  setReleaseDir('release');
  const manifest = latestJson(tag, version, `Quintal ${tag}`);
  writeFileSync(join('release', 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  filenames.push('latest.json');
  console.log(`latest.json: ${Object.keys(manifest.platforms).length} platforms for ${version}`);
} else {
  console.log(`No latest.json: prerelease=${prerelease}, newer already published=${Boolean(newerPublished)}`);
}

gh('release', 'upload', tag, ...filenames.map((name) => join('release', name)), '--clobber');
gh('release', 'edit', tag, '--draft=false', `--prerelease=${prerelease}`, `--latest=${!prerelease && !newerPublished}`);
