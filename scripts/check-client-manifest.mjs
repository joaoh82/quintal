/**
 * Every client component the server renders must be in the client manifest.
 *
 * This exists because of QUIN-9: a production build served `/settings/agents`
 * with `AgentsManager` missing from its client reference manifest, and React
 * threw "Could not find the module … in the React Client Manifest" while
 * rendering. Once. Never reproduced in thirty clean builds.
 *
 * The reason it is worth checking at build time rather than waiting for the
 * next occurrence is what that failure looks like from outside: the route can
 * answer **200** and stream HTML with the component silently absent. The smoke
 * test now catches that for the pages it covers, but only after a server is
 * running, and only for a page somebody remembered to list. The manifest is a
 * file on disk the moment the build ends. Check it there.
 *
 * What it compares:
 *
 *   from source  — every `'use client'` file imported by a file the server
 *                  actually renders, plus client pages and layouts;
 *   from .next   — the `clientModules` of every route's manifest.
 *
 * A boundary missing from a manifest fails the build. The opposite — a module
 * in the manifest that this script did not predict — is only reported, because
 * the prediction is a static read of imports and does not follow every way a
 * component can be reached (`next/dynamic` inside a server component, say).
 * Being wrong in that direction is harmless; being wrong the other way is the
 * bug this is here to catch.
 *
 *   node scripts/check-client-manifest.mjs [appDir]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const app = process.argv[2] ?? 'apps/web';
const src = join(app, 'src');
const dist = join(app, '.next');

function walk(dir, match, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, match, out);
    else if (match(name)) out.push(path);
  }
  return out;
}

// --- what the source says should be there ----------------------------------

const sources = walk(src, (n) => /\.(tsx?|jsx?)$/.test(n) && !/\.test\.tsx?$/.test(n));
const isClient = new Map(
  sources.map((f) => [resolve(f), /^['"]use client['"]/m.test(readFileSync(f, 'utf8'))]),
);

function resolveImport(fromFile, spec) {
  let base;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = resolve(src, spec.slice(2));
  else return null;
  for (const ext of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    if (isClient.has(resolve(base + ext))) return resolve(base + ext);
  }
  return null;
}

function importsOf(abs) {
  const out = [];
  for (const m of readFileSync(abs, 'utf8').matchAll(
    /^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm,
  )) {
    // `import type` is erased before the bundler sees it.
    if (/^\s*import\s+type\s/.test(m[0])) continue;
    const target = resolveImport(abs, m[1]);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Everything that ends up in the client bundle — not only the files carrying
 * the directive. A file with no directive that is imported solely by client
 * files is client code too: `RuntimeList.tsx` is exactly that. Treating it as
 * server code would make its own imports look like boundaries when nothing
 * server-side ever touches them.
 */
const clientGraph = new Set([...isClient].filter(([, yes]) => yes).map(([abs]) => abs));
for (let grew = true; grew; ) {
  grew = false;
  for (const abs of [...clientGraph]) {
    for (const target of importsOf(abs)) {
      if (!clientGraph.has(target)) {
        clientGraph.add(target);
        grew = true;
      }
    }
  }
}

const expected = new Set();
for (const file of sources) {
  const abs = resolve(file);
  if (isClient.get(abs) && /\/(page|layout|template|error|loading)\.tsx?$/.test(file)) {
    expected.add(abs);
  }
  if (clientGraph.has(abs)) continue;
  for (const target of importsOf(abs)) if (isClient.get(target)) expected.add(target);
}

// --- what the build actually wrote ------------------------------------------

const manifests = walk(join(dist, 'server', 'app'), (n) =>
  n.endsWith('_client-reference-manifest.js'),
);
if (manifests.length === 0) {
  console.error(`No client reference manifests under ${dist}. Build first.`);
  process.exit(2);
}

const show = (p) => relative(process.cwd(), p);
let failures = 0;
const unpredicted = new Set();

for (const file of manifests) {
  const context = { __RSC_MANIFEST: {} };
  runInNewContext(readFileSync(file, 'utf8'), context);
  for (const [route, manifest] of Object.entries(context.__RSC_MANIFEST)) {
    const present = new Set(Object.keys(manifest.clientModules).map((m) => resolve(m)));
    const missing = [...expected].filter((m) => !present.has(m));
    if (missing.length > 0) {
      failures++;
      console.error(`✖ ${route} — ${missing.length} client component(s) missing:`);
      for (const m of missing) console.error(`    ${show(m)}`);
    }
    for (const m of present) {
      // Stylesheets ride in `clientModules` too and are not components.
      if (/\.css$/.test(m)) continue;
      if (m.startsWith(resolve(src)) && !expected.has(m)) unpredicted.add(m);
    }
  }
}

console.log(
  `client manifest: ${expected.size} boundaries expected, ${manifests.length} route manifests checked`,
);
for (const m of unpredicted) {
  console.log(`  note: ${show(m)} is in the manifest but was not predicted from imports`);
}

if (failures > 0) {
  console.error(
    `\nA client component the server renders is absent from ${failures} manifest(s).\n` +
      `That build would serve those routes with the component missing — sometimes as a\n` +
      `500, sometimes as a 200 with a hole in the page. See QUIN-9. Rebuild; if it\n` +
      `persists, it is not the flake and something about the boundary really changed.`,
  );
  process.exit(1);
}
