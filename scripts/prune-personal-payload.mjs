import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const inside = (dir, path) => path === dir || path.startsWith(dir + sep);

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`Expected a deployed tree of real files: ${path}`);
  }
}

/** Index hoisted AND nested copies; package exports may hide package.json. */
function packagesIn(modules, packages = new Map()) {
  if (!existsSync(modules)) return packages;
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    const paths = entry.startsWith('@')
      ? readdirSync(join(modules, entry)).map((name) => join(modules, entry, name))
      : [join(modules, entry)];
    for (const path of paths) {
      if (!existsSync(join(path, 'package.json'))) continue;
      packages.set(path, readJson(join(path, 'package.json')));
      packagesIn(join(path, 'node_modules'), packages);
    }
  }
  return packages;
}

/**
 * Next traces are relative to each .nft.json, not to the app. Resolve them in
 * the build workspace, then map package name/version + subpath into pnpm's
 * hoisted deployment. Never transplant a .pnpm store path into the payload.
 * The custom server is untraced: retain its installed production closure,
 * including optional dependencies and peers, whole. Next itself stays whole.
 */
export function pruneFromTraces({ webSource, modules, nativePackages = [] }) {
  const packages = packagesIn(modules);
  const byIdentity = new Map();
  for (const [path, pkg] of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    if (!byIdentity.has(id)) byIdentity.set(id, []);
    byIdentity.get(id).push(path);
  }
  const whole = new Set();
  const keep = new Set();
  const buildOnly = (name) => name === 'typescript' || name.startsWith('@next/swc-');
  const web = join(modules, '@quintal/web');
  const server = join(modules, '@quintal/server');

  function dependency(from, name) {
    for (let dir = from; inside(dirname(modules), dir); dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (packages.has(candidate)) return candidate;
      if (dir === dirname(modules)) break;
    }
    return null;
  }

  function retainClosure(path) {
    if (whole.has(path)) return;
    const pkg = packages.get(path);
    if (!pkg) throw new Error(`Missing deployed package: ${path}`);
    whole.add(path);
    const required = pkg.dependencies ?? {};
    const optional = pkg.optionalDependencies ?? {};
    const names = new Set([...Object.keys(required), ...Object.keys(optional), ...Object.keys(pkg.peerDependencies ?? {})]);
    for (const name of names) {
      if (buildOnly(name)) continue;
      const found = dependency(path, name);
      if (found) retainClosure(found);
      else if (name in required && !(name in optional)) {
        throw new Error(`Missing production dependency ${name} of ${pkg.name}`);
      }
    }
  }

  retainClosure(server);
  if (!packages.has(web)) throw new Error(`Missing deployed web app: ${web}`);
  whole.add(web); // .next, public and compiled config were pruned separately.
  for (const [path, pkg] of packages) {
    if (nativePackages.includes(pkg.name)) retainClosure(path);
  }

  const sourcePackages = new Map();
  function retainTraceFile(source) {
    // Use the last node_modules boundary: pnpm store directories and nested
    // dependencies can both introduce earlier boundaries. A directory entry
    // is a package symlink in NFT output, not a request to ship its contents.
    const parts = source.split(sep);
    const at = parts.lastIndexOf('node_modules');
    if (at === -1) return; // workspace sources/build assets are kept whole.
    const end = at + (parts[at + 1]?.startsWith('@') ? 3 : 2);
    const packageDir = parts.slice(0, end).join(sep);
    const subpath = parts.slice(end).join(sep);
    if (!sourcePackages.has(packageDir)) sourcePackages.set(packageDir, readJson(join(packageDir, 'package.json')));
    const pkg = sourcePackages.get(packageDir);
    if (buildOnly(pkg.name)) return;
    // Native traces describe the host. The target's complete replacement is
    // already retained, including filenames that differ between platforms.
    if (nativePackages.includes(pkg.name)) return;
    const deployed = byIdentity.get(`${pkg.name}@${pkg.version}`);
    if (!deployed) throw new Error(`Traced package is missing from payload: ${pkg.name}@${pkg.version}`);
    for (const path of deployed) {
      keep.add(join(path, 'package.json'));
      if (!subpath || whole.has(path)) continue;
      const target = join(path, subpath);
      if (!existsSync(target)) throw new Error(`Traced file is missing from payload: ${target}`);
      if (statSync(target).isDirectory()) {
        for (const file of files(target)) keep.add(file);
      } else keep.add(target);
    }
  }

  function readTrace(path, base) {
    const trace = readJson(path);
    if (!Array.isArray(trace.files) || trace.files.some((file) => typeof file !== 'string')) {
      throw new Error(`Invalid Next file trace: ${path}`);
    }
    for (const file of trace.files) retainTraceFile(resolve(base, file));
  }

  const next = join(webSource, '.next');
  const serverTrace = join(next, 'next-server.js.nft.json');
  readTrace(serverTrace, dirname(serverTrace));
  const routes = [...files(join(next, 'server'))].filter((path) => path.endsWith('.nft.json'));
  if (routes.length === 0) throw new Error('No Next route traces found; rebuild the web app before pruning');
  for (const trace of routes) readTrace(trace, dirname(trace));
  readTrace(join(next, 'required-server-files.json'), webSource);

  // Finish validation and construct the removal list BEFORE deleting anything.
  // Keeping a package whole must not also keep unrelated nested packages.
  const remove = [];
  let bytes = 0;
  for (const path of files(modules)) {
    let owner = dirname(path);
    while (owner !== modules && !packages.has(owner)) owner = dirname(owner);
    if (whole.has(owner) || keep.has(path)) continue;
    remove.push(path);
    bytes += statSync(path).size;
  }
  for (const path of remove) rmSync(path);
  function removeEmpty(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) removeEmpty(join(dir, entry.name));
    }
    if (dir !== modules && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  }
  removeEmpty(modules);
  return {
    traces: routes.length + 2,
    removedFiles: remove.length,
    removedBytes: bytes,
    wholePackages: [...whole].map((path) => relative(modules, path)).sort(),
  };
}
